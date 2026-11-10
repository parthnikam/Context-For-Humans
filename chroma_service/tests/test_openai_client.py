"""Tests for the OpenAI project assignment client."""

from __future__ import annotations

import json
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from chroma_service import openai_client
from chroma_service.models import ProjectAssignmentRequest, TabClusterRequest
from chroma_service.tests.helpers import openai_response


class OpenAiClientTests(unittest.TestCase):
    def test_assignments_reuse_known_projects_and_name_new_projects(self):
        response = openai_response({
            "assignments": [
                {
                    "cluster_id": "cluster_1",
                    "existing_project_id": "project-react",
                    "project_name": "",
                    "intent": "",
                },
                {
                    "cluster_id": "cluster_2",
                    "existing_project_id": "",
                    "project_name": "Cooking",
                    "intent": "Collect recipe conversations.",
                },
            ],
        })
        with patch.object(openai_client, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(openai_client.requests, "post", return_value=response) as post:
            result = openai_client.assign_projects_with_openai(ProjectAssignmentRequest(
                existing_projects=[{
                    "id": "project-react",
                    "name": "React project",
                    "category_id": "programming",
                    "representative_titles": ["React hooks guide"],
                }],
                incoming_clusters=[
                    {
                        "cluster_id": "cluster_1",
                        "category_id": "programming",
                        "titles": ["React state guide"],
                    },
                    {
                        "cluster_id": "cluster_2",
                        "category_id": "cooking-recipes",
                        "titles": ["Best soup recipes"],
                    },
                ],
            ))

        self.assertEqual(result["model"], openai_client.OPENAI_MODEL)
        self.assertEqual(result["assignments"][0]["existing_project_id"], "project-react")
        self.assertEqual(result["assignments"][1]["project_name"], "Cooking")
        request = post.call_args.kwargs
        self.assertEqual(request["headers"]["Authorization"], "Bearer unit-test-key")
        self.assertEqual(request["json"]["model"], openai_client.OPENAI_MODEL)
        self.assertTrue(request["json"]["response_format"]["json_schema"]["strict"])
        self.assertIn("React project", request["json"]["messages"][1]["content"])

    def test_assignment_rejects_duplicate_cluster_ids(self):
        response = openai_response({
            "assignments": [
                {
                    "cluster_id": "cluster_1",
                    "existing_project_id": "",
                    "project_name": "Project",
                    "intent": "",
                },
                {
                    "cluster_id": "cluster_1",
                    "existing_project_id": "",
                    "project_name": "Another project",
                    "intent": "",
                },
            ],
        })
        request = ProjectAssignmentRequest(
            existing_projects=[],
            incoming_clusters=[
                {"cluster_id": "cluster_1", "titles": ["One"]},
                {"cluster_id": "cluster_2", "titles": ["Two"]},
            ],
        )
        with patch.object(openai_client, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(openai_client.requests, "post", return_value=response):
            with self.assertRaises(HTTPException) as error:
                openai_client.assign_projects_with_openai(request)
        self.assertEqual(error.exception.status_code, 502)

    def test_cannot_reuse_a_project_from_another_category(self):
        response = openai_response({
            "assignments": [{
                "cluster_id": "cluster_1",
                "existing_project_id": "project-films",
                "project_name": "",
                "intent": "",
            }],
        })
        request = ProjectAssignmentRequest(
            existing_projects=[{
                "id": "project-films",
                "name": "Film notes",
                "category_id": "movies-film",
            }],
            incoming_clusters=[{
                "cluster_id": "cluster_1",
                "category_id": "programming",
                "titles": ["Python project"],
            }],
        )
        with patch.object(openai_client, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(openai_client.requests, "post", return_value=response):
            with self.assertRaises(HTTPException) as error:
                openai_client.assign_projects_with_openai(request)
        self.assertIn("different category", error.exception.detail)

    def test_retries_assignments_with_missing_project_names(self):
        incomplete = openai_response({
            "assignments": [{
                "cluster_id": "cluster_1",
                "existing_project_id": "",
                "project_name": "",
                "intent": "",
            }],
        })
        corrected = openai_response({
            "assignments": [{
                "cluster_id": "cluster_1",
                "existing_project_id": "",
                "project_name": "React Hooks",
                "intent": "Learn React hooks.",
            }],
        })
        request = ProjectAssignmentRequest(
            existing_projects=[],
            incoming_clusters=[{
                "cluster_id": "cluster_1",
                "titles": ["React hooks guide"],
            }],
        )
        with patch.object(openai_client, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(openai_client.requests, "post", side_effect=[incomplete, corrected]) as post:
            result = openai_client.assign_projects_with_openai(request)

        self.assertEqual(result["assignments"][0]["project_name"], "React Hooks")
        self.assertEqual(post.call_count, 2)
        retry_payload = json.loads(post.call_args.kwargs["json"]["messages"][1]["content"])
        self.assertEqual(len(retry_payload["incoming_clusters"]), 1)
        self.assertIn("MUST be a non-empty", post.call_args.kwargs["json"]["messages"][0]["content"])

    def test_requires_a_server_side_key(self):
        with patch.object(openai_client, "load_openai_api_key", return_value=""):
            with self.assertRaises(HTTPException) as error:
                openai_client.test_openai_connection()
        self.assertEqual(error.exception.status_code, 503)

    def test_errors_never_return_the_api_key(self):
        secret = "unit-test-key"
        response = Mock(status_code=401)
        response.json.return_value = {"error": {"message": f"Invalid key {secret}"}}
        error = openai_client.openai_http_error(response, secret)
        self.assertNotIn(secret, error.detail)
        self.assertIn("[redacted]", error.detail)

    def test_cluster_tabs_normalizes_trails(self):
        response = openai_response({
            "trails": [
                {"label": "React work", "one_liner": "Learning React.", "tab_ids": [1, 2, 99]},
                {"label": "", "one_liner": "", "tab_ids": [2]},
            ],
        })
        request = TabClusterRequest(
            tabs=[
                {"id": 1, "title": "React docs", "url": "https://a.test/1"},
                {"id": 2, "title": "React forum", "url": "https://a.test/2"},
                {"id": 3, "title": "Python docs", "url": "https://a.test/3"},
            ],
            projects=[{"name": "React learning", "intent": ""}],
        )
        with patch.object(openai_client, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(openai_client.requests, "post", return_value=response) as post:
            result = openai_client.cluster_tabs(request)
        self.assertEqual(result["trails"][0]["label"], "React work")
        self.assertEqual(result["trails"][0]["tab_ids"], [1, 2])
        self.assertEqual(result["trails"][1]["label"], "Ungrouped")
        self.assertEqual(result["trails"][1]["tab_ids"], [3])
        payload = post.call_args.kwargs["json"]
        self.assertTrue(payload["response_format"]["json_schema"]["strict"])
        self.assertIn("React learning", payload["messages"][1]["content"])


if __name__ == "__main__":
    unittest.main()
