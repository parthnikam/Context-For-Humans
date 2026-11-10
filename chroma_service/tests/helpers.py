"""Shared fakes for the chroma_service unit tests."""

from __future__ import annotations

import json
from unittest.mock import Mock


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


def openai_response(content):
    response = Mock(ok=True)
    response.json.return_value = {
        "choices": [{"message": {"content": json.dumps(content)}}],
    }
    return response


def fake_classify_titles(titles, api_key=None):
    from chroma_service.categories import CATEGORY_BY_ID

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
            "category_name": CATEGORY_BY_ID[category_id][0],
        })
    return results
