"""Tests for the /cluster categorization and clustering pipeline."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from chroma_service import chroma_store, pipeline
from chroma_service.models import AssignmentRequest, ClusterRequest, Conversation
from chroma_service.tests.helpers import FakeCollection, fake_classify_titles


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.collection = FakeCollection()
        self.collection_patch = patch.object(chroma_store, "collection", self.collection)
        self.collection_patch.start()
        self.addCleanup(self.collection_patch.stop)
        self.classifier_patch = patch.object(
            pipeline,
            "classify_titles_with_typesafe",
            side_effect=fake_classify_titles,
        )
        self.classifier_patch.start()
        self.addCleanup(self.classifier_patch.stop)

    def cluster(self, conversations, similarity_threshold=0.62):
        return pipeline.cluster_conversations(
            [Conversation(title=title, url=url) for title, url in conversations],
            similarity_threshold,
        )

    def test_clusters_new_titles_and_suggests_projects_from_prior_csvs(self):
        first = self.cluster([
            ("react hooks guide", "https://one.test/a"),
            ("react hooks examples", "https://one.test/b"),
        ], similarity_threshold=0.25)
        self.assertEqual(len(first["clusters"]), 1)
        self.assertEqual(len(first["clusters"][0]["conversations"]), 2)

        chroma_store.apply_assignments(AssignmentRequest(assignments=[
            {
                "title": item["title"],
                "url": item["url"],
                "project_id": "project-react",
                "project_name": "React work",
                "category_id": "programming",
                "category_name": "Programming",
            }
            for item in first["clusters"][0]["conversations"]
        ]).assignments)

        second = self.cluster([
            ("react hooks tutorial", "https://two.test/c"),
            ("weekend soup recipe", "https://two.test/d"),
        ], similarity_threshold=0.2)
        self.assertEqual(len(second["clusters"]), 2)
        self.assertEqual(
            second["clusters"][0]["existing_project_candidates"][0]["project_id"],
            "project-react",
        )
        self.assertEqual(second["clusters"][1]["existing_project_candidates"], [])

    def test_upserts_are_persistent_by_normalized_url(self):
        first = self.cluster([
            ("first title", "https://example.test/a#old"),
        ])
        result = self.cluster([
            ("updated title", "https://example.test/a#new"),
        ])
        self.assertEqual(first["stored_titles"], 1)
        self.assertEqual(result["indexed_titles"], 1)
        self.assertEqual(result["stored_titles"], 1)
        record = next(iter(self.collection.records.values()))
        self.assertEqual(record["document"], "updated title")
        self.assertIn("category_id", record["metadata"])
        self.assertEqual(record["metadata"]["category_id"], "music")

    def test_titles_only_cluster_within_their_category(self):
        result = self.cluster([
            ("python programming basics", "https://example.test/code"),
            ("write a short poem", "https://example.test/poem"),
        ], similarity_threshold=0)

        self.assertEqual(len(result["clusters"]), 2)
        self.assertEqual(result["clusters"][0]["category_id"], "programming")
        self.assertEqual(result["clusters"][1]["category_id"], "writing-editing")

    def test_assignment_can_restore_project_metadata_to_existing_vectors(self):
        self.cluster([
            ("design doc", "https://example.test/design"),
        ])
        result = chroma_store.apply_assignments(AssignmentRequest(assignments=[
            {
                "title": "design doc",
                "url": "https://example.test/design",
                "project_id": "project-design",
                "project_name": "Design",
                "category_id": "general-reference",
                "category_name": "General reference",
            },
        ]).assignments)
        self.assertEqual(result, 1)
        self.assertEqual(
            next(iter(self.collection.records.values()))["metadata"]["project_name"],
            "Design",
        )

    def test_rejects_requests_without_valid_conversations(self):
        with self.assertRaises(ValueError):
            pipeline.cluster_conversations(
                [Conversation(title="no url", url="not-a-url")],
                0.62,
            )


if __name__ == "__main__":
    unittest.main()
