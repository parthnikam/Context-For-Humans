"""Tests for the OpenAI tool-calling ask agent."""

from __future__ import annotations

import json
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from chroma_service import qa
from chroma_service.models import Assignment


def completion(message):
    response = Mock(ok=True)
    response.json.return_value = {"choices": [{"message": message}]}
    return response


def tool_call_message(name, args, call_id="call-1"):
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [{
            "id": call_id,
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)},
        }],
    }


class AnswerQuestionTests(unittest.TestCase):
    def test_answers_after_searching_conversations(self):
        tool_round = completion(tool_call_message("search_conversations", {"query": "react"}))
        answer_round = completion({"role": "assistant", "content": "You filed React Hooks."})
        with patch.object(qa, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(
                    qa.chroma_store,
                    "search_matches",
                    return_value=[{
                        "title": "React hooks guide",
                        "url": "https://example.test/react",
                        "project_name": "React Hooks",
                    }],
                ) as search, patch.object(
                    qa.requests,
                    "post",
                    side_effect=[tool_round, answer_round],
                ) as post:
            result = qa.answer_question("what was I working on?")
        self.assertEqual(result["answer"], "You filed React Hooks.")
        self.assertEqual(result["sources"][0]["title"], "React hooks guide")
        self.assertEqual(result["projects"], ["React Hooks"])
        search.assert_called_once_with("react", 12)
        second_request = post.call_args_list[1].kwargs["json"]
        tool_messages = [m for m in second_request["messages"] if m.get("role") == "tool"]
        self.assertEqual(len(tool_messages), 1)
        self.assertEqual(tool_messages[0]["tool_call_id"], "call-1")
        self.assertIn("React hooks guide", tool_messages[0]["content"])

    def test_answers_after_searching_memory(self):
        tool_round = completion(tool_call_message("search_memory", {"query": "react work"}))
        answer_round = completion({"role": "assistant", "content": "You worked on React Hooks."})
        with patch.object(qa, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(
                    qa.mem0_client,
                    "search_memories",
                    return_value=["Project 'React Hooks' contains React hooks guide."],
                ), patch.object(
                    qa.requests,
                    "post",
                    side_effect=[tool_round, answer_round],
                ):
            result = qa.answer_question("what was I working on?")
        self.assertEqual(result["answer"], "You worked on React Hooks.")
        self.assertEqual(result["sources"], [])

    def test_returns_empty_memory_when_searches_find_nothing(self):
        tool_round = completion(tool_call_message("search_memory", {"query": "react work"}))
        answer_round = completion({"role": "assistant", "content": "Some generic answer."})
        with patch.object(qa, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(qa.mem0_client, "search_memories", return_value=[]), \
                patch.object(qa.requests, "post", side_effect=[tool_round, answer_round]):
            result = qa.answer_question("what was I working on?")
        self.assertEqual(result["answer"], qa.EMPTY_MEMORY)

    def test_rejects_empty_questions(self):
        with self.assertRaises(HTTPException) as error:
            qa.answer_question("   ")
        self.assertEqual(error.exception.status_code, 400)

    def test_requires_an_openai_key(self):
        with patch.object(qa, "load_openai_api_key", return_value=""):
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
