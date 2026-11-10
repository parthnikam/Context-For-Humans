"""Tests for the taxonomy and the FastAPI endpoint layer."""

from __future__ import annotations

import unittest

from chroma_service.app import health, list_categories
from chroma_service.categories import CATEGORIES


class EndpointTests(unittest.TestCase):
    def test_category_taxonomy_has_at_least_one_hundred_choices(self):
        self.assertGreaterEqual(len(CATEGORIES), 100)
        self.assertLessEqual(len(CATEGORIES), 255)
        self.assertEqual(len({category[0] for category in CATEGORIES}), len(CATEGORIES))

    def test_categories_endpoint_exposes_the_canonical_taxonomy(self):
        response = list_categories()
        self.assertEqual(len(response["categories"]), len(CATEGORIES))
        self.assertEqual(response["categories"][0]["id"], CATEGORIES[0][0])

    def test_health_reports_service_configuration(self):
        response = health()
        self.assertTrue(response["ok"])
        self.assertEqual(response["collection"], "conversation_titles")
        self.assertEqual(response["category_count"], len(CATEGORIES))
        self.assertIn("typesafe_model", response)
        self.assertIn("openai_model", response)


if __name__ == "__main__":
    unittest.main()
