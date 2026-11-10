"""Tests for the TypeSafe Jev classification client."""

from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from chroma_service import typesafe_client
from chroma_service.categories import CATEGORIES


class TypeSafeClassifierTests(unittest.TestCase):
    def test_choice_requests_return_validated_categories(self):
        response = Mock(ok=True)
        response.json.return_value = {
            "answers": {
                "title_0": {
                    "type": "choice",
                    "choice": "programming",
                    "confidence": 0.9,
                    "probabilities": {"programming": 0.9},
                },
                "title_1": {
                    "type": "choice",
                    "choice": "movies-film",
                    "confidence": 0.8,
                    "probabilities": {"movies-film": 0.8},
                },
            },
        }
        with patch.object(typesafe_client.requests, "post", return_value=response) as post:
            result = typesafe_client.classify_titles_with_typesafe(
                ["Python debugging help", "Movie recommendations"],
                api_key="unit-test-key",
            )

        self.assertEqual([item["category_id"] for item in result], ["programming", "movies-film"])
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], typesafe_client.TYPESAFE_MODEL)
        self.assertEqual(len(payload["questions"]), 2)
        self.assertEqual(len(payload["questions"]["title_0"]["criteria"]), len(CATEGORIES))
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer unit-test-key")

    def test_classifier_rejects_unknown_categories(self):
        response = Mock(ok=True)
        response.json.return_value = {
            "answers": {"title_0": {"choice": "made-up-category"}},
        }
        with patch.object(typesafe_client.requests, "post", return_value=response):
            with self.assertRaises(HTTPException) as error:
                typesafe_client.classify_titles_with_typesafe(["Odd title"], api_key="unit-test-key")
        self.assertEqual(error.exception.status_code, 502)

    def test_classifier_splits_batches_that_exceed_the_token_limit(self):
        import json as jsonlib
        request_count = {"value": 0}

        def fake_post(url, headers=None, json=None, timeout=None):
            request_count["value"] += 1
            if len(json["questions"]) > 1:
                response = Mock(status_code=400)
                response.json.return_value = {"detail": {"error_type": "max_tokens_exceeded"}}
                return response
            state = jsonlib.loads(json["state"])
            title = state["conversation_titles"][0]["title"]
            category_id = "programming" if "python" in title.lower() else "cooking-recipes"
            response = Mock(ok=True)
            response.json.return_value = {
                "answers": {
                    "title_0": {
                        "type": "choice",
                        "choice": category_id,
                        "confidence": 0.9,
                        "probabilities": {},
                    },
                },
            }
            return response

        with patch.object(typesafe_client.requests, "post", side_effect=fake_post):
            result = typesafe_client.classify_titles_with_typesafe(
                ["Python debugging help", "Best soup recipes"],
                api_key="unit-test-key",
            )

        self.assertEqual([item["category_id"] for item in result], ["programming", "cooking-recipes"])
        self.assertEqual(request_count["value"], 3)


if __name__ == "__main__":
    unittest.main()
