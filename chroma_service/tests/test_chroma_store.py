"""Tests for ChromaDB storage: search, persistence details, and clearing."""

from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from chroma_service import chroma_store
from chroma_service.models import AssignmentRequest, Conversation
from chroma_service.tests.helpers import FakeCollection


class ChromaStoreTests(unittest.TestCase):
    def setUp(self):
        self.collection = FakeCollection()
        self.collection_patch = patch.object(chroma_store, "collection", self.collection)
        self.collection_patch.start()
        self.addCleanup(self.collection_patch.stop)

    def index(self, conversations):
        record_ids = [chroma_store.record_id(url) for _, url in conversations]
        metadata = [
            {
                "url": chroma_store.normalize_url(url),
                "title": title,
                "project_id": "",
                "project_name": "",
                "category_id": "general-reference",
                "category_name": "General reference",
            }
            for title, url in conversations
        ]
        chroma_store.index_and_query(
            [Conversation(title=title, url=url) for title, url in conversations],
            record_ids,
            metadata,
        )
        return record_ids

    def test_similarity_search_returns_nearest_titles_and_project_metadata(self):
        self.index([
            ("react hooks tutorial", "https://example.test/react"),
            ("weekend soup recipe", "https://example.test/soup"),
        ])
        chroma_store.apply_assignments(AssignmentRequest(assignments=[            {
                "title": "react hooks tutorial",
                "url": "https://example.test/react",
                "project_id": "project-react",
                "project_name": "React",
                "category_id": "programming",
                "category_name": "Programming",
            },
            {
                "title": "weekend soup recipe",
                "url": "https://example.test/soup",
                "project_id": "project-cooking",
                "project_name": "Cooking",
                "category_id": "cooking-recipes",
                "category_name": "Cooking and recipes",
            },
        ]).assignments)

        matches = chroma_store.search_matches("react components", 12)

        self.assertEqual(matches[0]["url"], "https://example.test/react")
        self.assertEqual(matches[0]["project_id"], "project-react")
        self.assertGreaterEqual(matches[0]["similarity"], matches[1]["similarity"])
        self.assertEqual(len(chroma_store.search_matches("react", 1)), 1)

    def test_existing_url_lookup_ignores_fragments_and_returns_original_input(self):
        self.index([("react hooks tutorial", "https://example.test/react")])

        existing = chroma_store.get_existing_urls([
            "https://example.test/react#chat",
            "https://example.test/new",
        ])

        self.assertEqual(existing, ["https://example.test/react#chat"])

    def test_clear_recreates_the_empty_collection(self):
        fake_client = Mock()
        replacement_collection = FakeCollection()
        fake_client.get_or_create_collection.return_value = replacement_collection
        with patch.object(chroma_store, "client", fake_client):
            chroma_store.clear_collection()
        fake_client.delete_collection.assert_called_once_with(chroma_store.COLLECTION_NAME)
        fake_client.get_or_create_collection.assert_called_once()
        self.assertIs(chroma_store.collection, replacement_collection)


if __name__ == "__main__":
    unittest.main()
