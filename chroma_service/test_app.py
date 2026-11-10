import unittest
from unittest.mock import patch

from chroma_service import app as service


class FakeCollection:
    def __init__(self):
        self.records = {}

    def count(self):
        return len(self.records)

    def get(self, ids, include):
        found = [record_id for record_id in ids if record_id in self.records]
        result = {"ids": found}
        if "metadatas" in include:
            result["metadatas"] = [self.records[item]["metadata"] for item in found]
        if "documents" in include:
            result["documents"] = [self.records[item]["document"] for item in found]
        return result

    def upsert(self, ids, documents, metadatas):
        for item_id, document, metadata in zip(ids, documents, metadatas):
            self.records[item_id] = {"document": document, "metadata": metadata}

    def update(self, ids, metadatas, documents=None):
        documents = documents or [self.records[item_id]["document"] for item_id in ids]
        for item_id, metadata, document in zip(ids, metadatas, documents):
            self.records[item_id] = {"document": document, "metadata": metadata}

    def query(self, query_texts, n_results, include):
        ids_batch = []
        docs_batch = []
        metadata_batch = []
        distances_batch = []
        for query in query_texts:
            matches = []
            for item_id, record in self.records.items():
                score = similarity(query, record["document"])
                matches.append((item_id, record, 1 - score))
            matches.sort(key=lambda result: result[2])
            matches = matches[:n_results]
            ids_batch.append([item[0] for item in matches])
            docs_batch.append([item[1]["document"] for item in matches])
            metadata_batch.append([item[1]["metadata"] for item in matches])
            distances_batch.append([item[2] for item in matches])
        return {
            "ids": ids_batch,
            "documents": docs_batch,
            "metadatas": metadata_batch,
            "distances": distances_batch,
        }


def similarity(left, right):
    a = set(left.lower().split())
    b = set(right.lower().split())
    return len(a & b) / len(a | b) if a or b else 0


class ChromaServiceTests(unittest.TestCase):
    def setUp(self):
        self.collection = FakeCollection()
        self.collection_patch = patch.object(service, "collection", self.collection)
        self.collection_patch.start()
        self.addCleanup(self.collection_patch.stop)

    def test_clusters_new_titles_and_suggests_projects_from_prior_csvs(self):
        first = service.cluster_titles(service.ClusterRequest(
            conversations=[
                {"title": "react hooks guide", "url": "https://one.test/a"},
                {"title": "react hooks examples", "url": "https://one.test/b"},
            ],
            similarity_threshold=0.25,
        ))
        self.assertEqual(len(first["clusters"]), 1)
        self.assertEqual(len(first["clusters"][0]["conversations"]), 2)

        service.assign_projects(service.AssignmentRequest(assignments=[
            {
                "title": item["title"],
                "url": item["url"],
                "project_id": "project-react",
                "project_name": "React work",
            }
            for item in first["clusters"][0]["conversations"]
        ]))

        second = service.cluster_titles(service.ClusterRequest(
            conversations=[
                {"title": "react hooks tutorial", "url": "https://two.test/c"},
                {"title": "weekend soup recipe", "url": "https://two.test/d"},
            ],
            similarity_threshold=0.2,
        ))
        self.assertEqual(len(second["clusters"]), 2)
        self.assertEqual(
            second["clusters"][0]["existing_project_candidates"][0]["project_id"],
            "project-react",
        )
        self.assertEqual(second["clusters"][1]["existing_project_candidates"], [])

    def test_upserts_are_persistent_by_normalized_url(self):
        request = service.ClusterRequest(conversations=[
            {"title": "first title", "url": "https://example.test/a#old"},
            {"title": "updated title", "url": "https://example.test/a#new"},
        ])
        result = service.cluster_titles(request)
        self.assertEqual(result["indexed_titles"], 1)
        self.assertEqual(result["stored_titles"], 1)
        record = next(iter(self.collection.records.values()))
        self.assertEqual(record["document"], "updated title")

    def test_assignment_can_restore_project_metadata_to_existing_vectors(self):
        service.cluster_titles(service.ClusterRequest(conversations=[
            {"title": "design doc", "url": "https://example.test/design"},
        ]))
        result = service.assign_projects(service.AssignmentRequest(assignments=[
            {
                "title": "design doc",
                "url": "https://example.test/design",
                "project_id": "project-design",
                "project_name": "Design",
            },
        ]))
        self.assertEqual(result["updated"], 1)
        self.assertEqual(
            next(iter(self.collection.records.values()))["metadata"]["project_name"],
            "Design",
        )


if __name__ == "__main__":
    unittest.main()
