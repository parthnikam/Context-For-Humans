"""Tests for question answering over filed projects."""

from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from chroma_service import qa
from chroma_service.models import Assignment


class AnswerQuestionTests(unittest.TestCase):
    def test_answers_from_memories_and_matches(self):
        openai = Mock(ok=True)
        openai.json.return_value = {
            "choices": [{"message": {"content": "You filed React Hooks."}}],
        }
        with patch.object(
            qa.mem0_client,
            "search_memories",
            return_value=["Project 'React Hooks' contains React hooks guide."],
        ), patch.object(
            qa.chroma_store,
            "search_matches",
            return_value=[{
                "title": "React hooks guide",
                "url": "https://example.test/react",
                "project_name": "React Hooks",
            }],
        ), patch.object(
            qa,
            "load_openai_api_key",
            return_value="unit-test-key",
        ), patch.object(
            qa.requests,
            "post",
            return_value=openai,
        ) as post:
            result = qa.answer_question("what was I working on?")
        self.assertEqual(result["answer"], "You filed React Hooks.")
        self.assertEqual(result["memories"], ["Project 'React Hooks' contains React hooks guide."])
        self.assertEqual(result["matches"][0]["project"], "React Hooks")
        user_content = post.call_args.kwargs["json"]["messages"][1]["content"]
        self.assertIn("React hooks guide", user_content)
        self.assertIn("Question: what was I working on?", user_content)

    def test_rejects_empty_questions(self):
        with self.assertRaises(HTTPException) as error:
            qa.answer_question("   ")
        self.assertEqual(error.exception.status_code, 400)

    def test_requires_an_openai_key(self):
        with patch.object(qa.mem0_client, "search_memories", return_value=[]), \
                patch.object(qa.chroma_store, "search_matches", return_value=[]), \
                patch.object(qa, "load_openai_api_key", return_value=""):
            with self.assertRaises(HTTPException) as error:
                qa.answer_question("what?")
        self.assertEqual(error.exception.status_code, 503)


class RememberProjectsTests(unittest.TestCase):
    def test_groups_assignments_into_project_memories(self):
        assignments = [
            Assignment(
                title="React hooks",
                url="https://example.test/a",
                project_id="p1",
                project_name="React Hooks",
                category_id="programming",
                category_name="Programming",
            ),
            Assignment(
                title="React state",
                url="https://example.test/b",
                project_id="p1",
                project_name="React Hooks",
                category_id="programming",
                category_name="Programming",
            ),
        ]
        with patch.object(qa.mem0_client, "add_memories", return_value=1) as add:
            self.assertEqual(qa.remember_projects(assignments), 1)
        entries = add.call_args.args[0]
        self.assertEqual(len(entries), 1)
        self.assertIn("React hooks", entries[0]["content"])
        self.assertIn("React state", entries[0]["content"])
        self.assertEqual(entries[0]["metadata"]["project_id"], "p1")
        self.assertEqual(entries[0]["metadata"]["kind"], "project")

    def test_never_raises_when_mem0_fails(self):
        with patch.object(qa.mem0_client, "add_memories", side_effect=RuntimeError("down")):
            self.assertEqual(qa.remember_projects([
                Assignment(
                    title="t",
                    url="https://example.test/a",
                    project_id="p1",
                    project_name="P",
                    category_id="c",
                    category_name="C",
                ),
            ]), 0)


if __name__ == "__main__":
    unittest.main()
