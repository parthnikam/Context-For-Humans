"""ChromaDB access: the persistent collection, URL identity, clustering, and search."""

from __future__ import annotations

import hashlib
import threading
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import chromadb

from chroma_service.config import COLLECTION_NAME, DATA_DIR, QUERY_BATCH_SIZE, SEARCH_TOP_K
from chroma_service.models import Assignment, Conversation

client = chromadb.PersistentClient(path=str(DATA_DIR))
collection = client.get_or_create_collection(
    name=COLLECTION_NAME,
    metadata={"hnsw:space": "cosine"},
)
collection_lock = threading.RLock()


def normalize_url(value: str) -> str:
    parts = urlsplit(value.strip())
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return ""
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, parts.query, ""))


def url_key(value: str) -> str:
    return normalize_url(value).casefold()


def record_id(url: str) -> str:
    return hashlib.sha256(url_key(url).encode("utf-8")).hexdigest()


def count() -> int:
    with collection_lock:
        return collection.count()


def get_stored_metadata(record_ids: list[str]) -> dict[str, dict[str, Any]]:
    with collection_lock:
        stored = collection.get(ids=record_ids, include=["metadatas"])
    return {
        record_id: metadata or {}
        for record_id, metadata in zip(stored["ids"], stored.get("metadatas") or [])
    }


def index_and_query(
    unique: list[Conversation],
    record_ids: list[str],
    metadata: list[dict[str, str]],
) -> tuple[list[list[dict[str, Any]]], int]:
    """Upsert the conversations and return their nearest neighbours per title."""
    with collection_lock:
        collection.upsert(
            ids=record_ids,
            documents=[conversation.title for conversation in unique],
            metadatas=metadata,
        )
        total_count = collection.count()
        n_results = min(total_count, SEARCH_TOP_K)
        query_results = []
        for start in range(0, len(unique), QUERY_BATCH_SIZE):
            batch = unique[start:start + QUERY_BATCH_SIZE]
            query_results.append(collection.query(
                query_texts=[conversation.title for conversation in batch],
                n_results=n_results,
                include=["metadatas", "documents", "distances"],
            ))

    flat_results: list[list[dict[str, Any]]] = []
    for result_batch in query_results:
        ids_batch = result_batch.get("ids") or []
        docs_batch = result_batch.get("documents") or []
        metadata_batch = result_batch.get("metadatas") or []
        distances_batch = result_batch.get("distances") or []
        for ids, docs, metadatas, distances in zip(ids_batch, docs_batch, metadata_batch, distances_batch):
            flat_results.append([
                {
                    "id": item_id,
                    "title": (item_metadata or {}).get("title") or (docs[index] if index < len(docs) else ""),
                    "url": (item_metadata or {}).get("url", ""),
                    "project_id": (item_metadata or {}).get("project_id", ""),
                    "project_name": (item_metadata or {}).get("project_name", ""),
                    "category_id": (item_metadata or {}).get("category_id", ""),
                    "category_name": (item_metadata or {}).get("category_name", ""),
                    "similarity": round(1 - float(distance), 6),
                }
                for index, (item_id, item_metadata, distance) in enumerate(zip(ids, metadatas, distances))
            ])
    return flat_results, total_count


def build_clusters(
    conversations: list[Conversation],
    record_ids: list[str],
    incoming_ids: set[str],
    search_results: list[list[dict[str, Any]]],
    threshold: float,
    categories_by_index: dict[int, dict[str, str]],
) -> list[dict[str, Any]]:
    parent = list(range(len(conversations)))
    rank = [0] * len(conversations)
    index_by_id = {item_id: index for index, item_id in enumerate(record_ids)}

    def find(index: int) -> int:
        if parent[index] != index:
            parent[index] = find(parent[index])
        return parent[index]

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root == right_root:
            return
        if rank[left_root] < rank[right_root]:
            left_root, right_root = right_root, left_root
        parent[right_root] = left_root
        if rank[left_root] == rank[right_root]:
            rank[left_root] += 1

    project_matches: list[dict[str, dict[str, Any]]] = [
        {} for _ in conversations
    ]
    for source_index, results in enumerate(search_results):
        for result in results:
            similarity = float(result["similarity"])
            if similarity < threshold:
                continue
            source_category = categories_by_index[source_index]["category_id"]
            if result.get("category_id") != source_category:
                continue
            target_index = index_by_id.get(result["id"])
            if target_index is not None and target_index != source_index:
                union(source_index, target_index)
            project_id = result.get("project_id")
            project_name = result.get("project_name")
            if project_id and project_name and result["id"] not in incoming_ids:
                previous = project_matches[source_index].get(project_id)
                if previous is None or similarity > previous["similarity"]:
                    project_matches[source_index][project_id] = {
                        "project_id": project_id,
                        "name": project_name,
                        "similarity": similarity,
                        "matched_title": result.get("title", ""),
                    }

    members: dict[int, list[int]] = {}
    for index in range(len(conversations)):
        members.setdefault(find(index), []).append(index)

    ordered_members = sorted(members.values(), key=lambda indices: indices[0])
    output = []
    for cluster_index, indices in enumerate(ordered_members):
        candidates: dict[str, dict[str, Any]] = {}
        for index in indices:
            for project_id, candidate in project_matches[index].items():
                previous = candidates.get(project_id)
                if previous is None or candidate["similarity"] > previous["similarity"]:
                    candidates[project_id] = candidate
        output.append({
            "cluster_id": f"cluster-{cluster_index}",
            "category_id": categories_by_index[indices[0]]["category_id"],
            "category_name": categories_by_index[indices[0]]["category_name"],
            "conversations": [
                {
                    "title": conversations[index].title,
                    "url": conversations[index].url,
                }
                for index in indices
            ],
            "existing_project_candidates": sorted(
                candidates.values(),
                key=lambda candidate: candidate["similarity"],
                reverse=True,
            )[:10],
        })
    return output


def search_matches(query: str, limit: int) -> list[dict[str, Any]]:
    with collection_lock:
        stored_count = collection.count()
        if not stored_count:
            return []
        result = collection.query(
            query_texts=[query],
            n_results=min(limit, stored_count),
            include=["metadatas", "documents", "distances"],
        )
    ids = (result.get("ids") or [[]])[0]
    documents = (result.get("documents") or [[]])[0]
    metadatas = (result.get("metadatas") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]
    matches = []
    for index, (item_id, metadata, distance) in enumerate(zip(ids, metadatas, distances)):
        metadata = metadata or {}
        matches.append({
            "id": item_id,
            "title": metadata.get("title") or (documents[index] if index < len(documents) else ""),
            "url": metadata.get("url", ""),
            "project_id": metadata.get("project_id", ""),
            "project_name": metadata.get("project_name", ""),
            "similarity": round(1 - float(distance), 6),
        })
    return matches


def apply_assignments(assignments: list[Assignment]) -> int:
    """Persist project, category, and title metadata for every assignment."""
    ids = [record_id(normalize_url(item.url)) for item in assignments]
    with collection_lock:
        records = collection.get(ids=ids, include=["metadatas", "documents"])
        known = {
            record_id: {
                "metadata": metadata or {},
                "document": document or "",
            }
            for record_id, metadata, document in zip(
                records["ids"],
                records.get("metadatas") or [],
                records.get("documents") or [],
            )
        }
        update_ids = []
        update_metadatas = []
        upsert_ids = []
        upsert_metadatas = []
        upsert_documents = []
        for assignment, item_id in zip(assignments, ids):
            existing = known.get(item_id)
            item_metadata = dict(existing["metadata"]) if existing else {}
            item_metadata.update({
                "url": normalize_url(assignment.url),
                "title": assignment.title.strip(),
                "project_id": assignment.project_id,
                "project_name": assignment.project_name.strip(),
                "category_id": assignment.category_id,
                "category_name": assignment.category_name.strip(),
            })
            if existing:
                update_ids.append(item_id)
                update_metadatas.append(item_metadata)
            else:
                upsert_ids.append(item_id)
                upsert_metadatas.append(item_metadata)
                upsert_documents.append(assignment.title.strip())
        if update_ids:
            collection.update(
                ids=update_ids,
                metadatas=update_metadatas,
            )
        if upsert_ids:
            collection.upsert(
                ids=upsert_ids,
                metadatas=upsert_metadatas,
                documents=upsert_documents,
            )
    return len(ids)


def clear_collection() -> None:
    global collection
    with collection_lock:
        client.delete_collection(COLLECTION_NAME)
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
