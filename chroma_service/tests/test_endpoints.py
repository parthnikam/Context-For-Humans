"""Tests for the taxonomy and the FastAPI endpoint layer."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from chroma_service import app as service
from chroma_service.categories import CATEGORIES


class EndpointTests(unittest.TestCase):
    def test_category_taxonomy_has_at_least_one_hundred_choices(self):
        self.assertGreaterEqual(len(CATEGORIES), 100)
        self.assertLessEqual(len(CATEGORIES), 255)
        self.assertEqual(len({category[0] for category in CATEGORIES}), len(CATEGORIES))

    def test_categories_endpoint_exposes_the_canonical_taxonomy(self):
        response = service.list_categories()
        self.assertEqual(len(response["categories"]), len(CATEGORIES))
        self.assertEqual(response["categories"][0]["id"], CATEGORIES[0][0])

    def test_health_reports_service_configuration(self):
        response = service.health()
        self.assertTrue(response["ok"])
        self.assertEqual(response["collection"], "conversation_titles")
        self.assertEqual(response["category_count"], len(CATEGORIES))
        self.assertIn("typesafe_model", response)
        self.assertIn("openai_model", response)

    def test_ask_route_delegates_to_the_qa_pipeline(self):
        with patch.object(
            service.qa,
            "answer_question",
            return_value={"answer": "You filed React Hooks.", "memories": [], "matches": []},
        ) as answer:
            result = service.ask(service.AskRequest(question="what was I working on?"))
        self.assertEqual(result["answer"], "You filed React Hooks.")
        answer.assert_called_once_with("what was I working on?", "local-user")

    def test_assign_route_memorizes_projects(self):
        request = service.AssignmentRequest(assignments=[{
            "title": "React hooks",
            "url": "https://example.test/a",
            "project_id": "p1",
            "project_name": "React Hooks",
            "category_id": "programming",
            "category_name": "Programming",
        }])
        with patch.object(service.chroma_store, "apply_assignments", return_value=1) as apply, \
                patch.object(service.qa, "remember_projects", return_value=1) as remember:
            result = service.assign_projects_metadata(request)
        self.assertEqual(result, {"updated": 1, "memorized": 1})
        apply.assert_called_once()
        remember.assert_called_once()
        self.assertEqual(len(remember.call_args.args[0]), 1)


if __name__ == "__main__":
    unittest.main()
