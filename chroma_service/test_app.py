import json
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from chroma_service import app as service
from chroma_service.categories import CATEGORIES

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
        self.classifier_patch = patch.object(
            service,
            "classify_titles_with_typesafe",
            side_effect=fake_classify_titles,
        )
        self.classifier_patch.start()
        self.addCleanup(self.classifier_patch.stop)

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
                "category_id": "programming",
                "category_name": "Programming",
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
        first = service.cluster_titles(service.ClusterRequest(conversations=[
            {"title": "first title", "url": "https://example.test/a#old"},
        ]))
        result = service.cluster_titles(service.ClusterRequest(conversations=[
            {"title": "updated title", "url": "https://example.test/a#new"},
        ]))
        self.assertEqual(first["stored_titles"], 1)
        self.assertEqual(result["indexed_titles"], 1)
        self.assertEqual(result["stored_titles"], 1)
        record = next(iter(self.collection.records.values()))
        self.assertEqual(record["document"], "updated title")
        self.assertIn("category_id", record["metadata"])
        self.assertEqual(record["metadata"]["category_id"], "music")

    def test_titles_only_cluster_within_their_category(self):
        result = service.cluster_titles(service.ClusterRequest(conversations=[
            {"title": "python programming basics", "url": "https://example.test/code"},
            {"title": "write a short poem", "url": "https://example.test/poem"},
        ], similarity_threshold=0))

        self.assertEqual(len(result["clusters"]), 2)
        self.assertEqual(result["clusters"][0]["category_id"], "programming")
        self.assertEqual(result["clusters"][1]["category_id"], "writing-editing")

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
                "category_id": "general-reference",
                "category_name": "General reference",
            },
        ]))
        self.assertEqual(result["updated"], 1)
        self.assertEqual(
            next(iter(self.collection.records.values()))["metadata"]["project_name"],
            "Design",
        )

    def test_similarity_search_returns_nearest_titles_and_project_metadata(self):
        service.cluster_titles(service.ClusterRequest(conversations=[
            {"title": "react hooks tutorial", "url": "https://example.test/react"},
            {"title": "weekend soup recipe", "url": "https://example.test/soup"},
        ]))
        service.assign_projects(service.AssignmentRequest(assignments=[
            {
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
        ]))

        result = service.search_titles(service.SearchRequest(query="react components"))

        self.assertEqual(result["query"], "react components")
        self.assertEqual(result["matches"][0]["url"], "https://example.test/react")
        self.assertEqual(result["matches"][0]["project_id"], "project-react")
        self.assertGreaterEqual(result["matches"][0]["similarity"], result["matches"][1]["similarity"])
        self.assertEqual(len(service.search_titles(service.SearchRequest(
            query="react",
            limit=1,
        ))["matches"]), 1)

    def test_openai_assignments_reuse_known_projects_and_name_new_projects(self):
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
        with patch.object(service, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(service.requests, "post", return_value=response) as post:
            result = service.assign_projects_with_openai(service.ProjectAssignmentRequest(
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

        self.assertEqual(result["model"], service.OPENAI_MODEL)
        self.assertEqual(result["assignments"][0]["existing_project_id"], "project-react")
        self.assertEqual(result["assignments"][1]["project_name"], "Cooking")
        request = post.call_args.kwargs
        self.assertEqual(request["headers"]["Authorization"], "Bearer unit-test-key")
        self.assertEqual(request["json"]["model"], service.OPENAI_MODEL)
        self.assertTrue(request["json"]["response_format"]["json_schema"]["strict"])
        self.assertIn("React project", request["json"]["messages"][1]["content"])

    def test_openai_assignment_rejects_duplicate_cluster_ids(self):
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
        request = service.ProjectAssignmentRequest(
            existing_projects=[],
            incoming_clusters=[
                {"cluster_id": "cluster_1", "titles": ["One"]},
                {"cluster_id": "cluster_2", "titles": ["Two"]},
            ],
        )
        with patch.object(service, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(service.requests, "post", return_value=response):
            with self.assertRaises(HTTPException) as error:
                service.assign_projects_with_openai(request)
        self.assertEqual(error.exception.status_code, 502)

    def test_openai_cannot_reuse_a_project_from_another_category(self):
        response = openai_response({
            "assignments": [{
                "cluster_id": "cluster_1",
                "existing_project_id": "project-films",
                "project_name": "",
                "intent": "",
            }],
        })
        request = service.ProjectAssignmentRequest(
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
        with patch.object(service, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(service.requests, "post", return_value=response):
            with self.assertRaises(HTTPException) as error:
                service.assign_projects_with_openai(request)
        self.assertIn("different category", error.exception.detail)

    def test_openai_retries_assignments_with_missing_project_names(self):
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
        request = service.ProjectAssignmentRequest(
            existing_projects=[],
            incoming_clusters=[{
                "cluster_id": "cluster_1",
                "titles": ["React hooks guide"],
            }],
        )
        with patch.object(service, "load_openai_api_key", return_value="unit-test-key"), \
                patch.object(service.requests, "post", side_effect=[incomplete, corrected]) as post:
            result = service.assign_projects_with_openai(request)

        self.assertEqual(result["assignments"][0]["project_name"], "React Hooks")
        self.assertEqual(post.call_count, 2)
        retry_payload = json.loads(post.call_args.kwargs["json"]["messages"][1]["content"])
        self.assertEqual(len(retry_payload["incoming_clusters"]), 1)
        self.assertIn("MUST be a non-empty", post.call_args.kwargs["json"]["messages"][0]["content"])

    def test_openai_endpoints_require_a_server_side_key(self):
        with patch.object(service, "load_openai_api_key", return_value=""):
            with self.assertRaises(HTTPException) as error:
                service.test_openai()
        self.assertEqual(error.exception.status_code, 503)

    def test_category_taxonomy_has_at_least_one_hundred_choices(self):
        self.assertGreaterEqual(len(CATEGORIES), 100)
        self.assertLessEqual(len(CATEGORIES), 255)
        self.assertEqual(len({category[0] for category in CATEGORIES}), len(CATEGORIES))

    def test_categories_endpoint_exposes_the_canonical_taxonomy(self):
        response = service.list_categories()
        self.assertEqual(len(response["categories"]), len(CATEGORIES))
        self.assertEqual(response["categories"][0]["id"], CATEGORIES[0][0])

    def test_clear_index_recreates_the_empty_collection(self):
        fake_client = Mock()
        replacement_collection = FakeCollection()
        fake_client.get_or_create_collection.return_value = replacement_collection
        with patch.object(service, "client", fake_client):
            result = service.clear_index()
        self.assertEqual(result, {"cleared": True})
        fake_client.delete_collection.assert_called_once_with(service.COLLECTION_NAME)
        fake_client.get_or_create_collection.assert_called_once()
        self.assertIs(service.collection, replacement_collection)

    def test_openai_errors_never_return_the_api_key(self):
        secret = "unit-test-key"
        response = Mock(status_code=401)
        response.json.return_value = {"error": {"message": f"Invalid key {secret}"}}
        error = service.openai_http_error(response, secret)
        self.assertNotIn(secret, error.detail)
        self.assertIn("[redacted]", error.detail)


def openai_response(content):
    response = Mock(ok=True)
    response.json.return_value = {
        "choices": [{"message": {"content": json.dumps(content)}}],
    }
    return response


def fake_classify_titles(titles, api_key=None):
    results = []
    for title in titles:
        normalized = title.lower()
        if "react" in normalized or "python" in normalized or "code" in normalized or "program" in normalized:
            category_id = "programming"
        elif "poem" in normalized or "write" in normalized:
            category_id = "writing-editing"
        elif "soup" in normalized or "recipe" in normalized:
            category_id = "cooking-recipes"
        elif "updated" in normalized:
            category_id = "music"
        else:
            category_id = "general-reference"
        results.append({
            "category_id": category_id,
            "category_name": service.CATEGORY_BY_ID[category_id][0],
        })
    return results


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
        with patch.object(service.requests, "post", return_value=response) as post:
            result = service.classify_titles_with_typesafe(
                ["Python debugging help", "Movie recommendations"],
                api_key="unit-test-key",
            )

        self.assertEqual([item["category_id"] for item in result], ["programming", "movies-film"])
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], service.TYPESAFE_MODEL)
        self.assertEqual(len(payload["questions"]), 2)
        self.assertEqual(len(payload["questions"]["title_0"]["criteria"]), len(CATEGORIES))
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer unit-test-key")

    def test_classifier_rejects_unknown_categories(self):
        response = Mock(ok=True)
        response.json.return_value = {
            "answers": {"title_0": {"choice": "made-up-category"}},
        }
        with patch.object(service.requests, "post", return_value=response):
            with self.assertRaises(HTTPException) as error:
                service.classify_titles_with_typesafe(["Odd title"], api_key="unit-test-key")
        self.assertEqual(error.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
