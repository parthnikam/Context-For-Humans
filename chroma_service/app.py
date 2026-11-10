from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import chromadb
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

SERVICE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CHROMA_DATA_DIR", SERVICE_DIR / "data")).resolve()
COLLECTION_NAME = "conversation_titles"
MAX_CONVERSATIONS = 2000
QUERY_BATCH_SIZE = 64
SEARCH_TOP_K = 40

client = chromadb.PersistentClient(path=str(DATA_DIR))
collection = client.get_or_create_collection(
    name=COLLECTION_NAME,
    metadata={"hnsw:space": "cosine"},
)
collection_lock = threading.RLock()

app = FastAPI(title="Conversation Exporter Chroma Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


class Conversation(BaseModel):
    title: str = Field(min_length=1, max_length=1000)
    url: str = Field(min_length=1, max_length=4096)


class ClusterRequest(BaseModel):
    conversations: list[Conversation] = Field(min_length=1, max_length=MAX_CONVERSATIONS)
    similarity_threshold: float = Field(default=0.62, ge=0, le=1)


class Assignment(BaseModel):
    url: str = Field(min_length=1, max_length=4096)
    title: str = Field(min_length=1, max_length=1000)
    project_id: str = Field(min_length=1, max_length=200)
    project_name: str = Field(min_length=1, max_length=200)


class AssignmentRequest(BaseModel):
    assignments: list[Assignment] = Field(min_length=1, max_length=MAX_CONVERSATIONS)


@app.get("/health")
def health() -> dict[str, Any]:
    with collection_lock:
        return {
            "ok": True,
            "collection": COLLECTION_NAME,
            "stored_titles": collection.count(),
            "data_directory": str(DATA_DIR),
        }


@app.post("/cluster")
def cluster_titles(request: ClusterRequest) -> dict[str, Any]:
    unique_by_url: dict[str, Conversation] = {}
    for conversation in request.conversations:
        title = conversation.title.strip()
        url = normalize_url(conversation.url)
        if not title or not url:
            continue
        key = url_key(url)
        unique_by_url[key] = Conversation(title=title, url=url)
    unique = list(unique_by_url.values())
    if not unique:
        raise HTTPException(status_code=400, detail="No unique valid conversations were provided.")

    record_ids = [record_id(conversation.url) for conversation in unique]
    incoming_ids = set(record_ids)

    with collection_lock:
        stored = collection.get(ids=record_ids, include=["metadatas"])
        stored_metadata = {
            record_id: metadata or {}
            for record_id, metadata in zip(stored["ids"], stored.get("metadatas") or [])
        }
        metadata = []
        for index, conversation in enumerate(unique):
            existing = stored_metadata.get(record_ids[index], {})
            metadata.append({
                "url": conversation.url,
                "title": conversation.title,
                "project_id": str(existing.get("project_id", "")),
                "project_name": str(existing.get("project_name", "")),
            })
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
                    "similarity": round(1 - float(distance), 6),
                }
                for index, (item_id, item_metadata, distance) in enumerate(zip(ids, metadatas, distances))
            ])

    clusters = build_clusters(unique, record_ids, incoming_ids, flat_results, request.similarity_threshold)
    return {
        "clusters": clusters,
        "indexed_titles": len(unique),
        "stored_titles": total_count,
        "similarity_threshold": request.similarity_threshold,
    }


@app.post("/assign")
def assign_projects(request: AssignmentRequest) -> dict[str, Any]:
    ids = [record_id(normalize_url(item.url)) for item in request.assignments]
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
        for assignment, item_id in zip(request.assignments, ids):
            existing = known.get(item_id)
            item_metadata = dict(existing["metadata"]) if existing else {}
            item_metadata.update({
                "url": normalize_url(assignment.url),
                "title": assignment.title.strip(),
                "project_id": assignment.project_id,
                "project_name": assignment.project_name.strip(),
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
    return {"updated": len(ids)}


@app.post("/clear")
def clear_index() -> dict[str, Any]:
    global collection
    with collection_lock:
        client.delete_collection(COLLECTION_NAME)
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    return {"cleared": True}


def build_clusters(
    conversations: list[Conversation],
    record_ids: list[str],
    incoming_ids: set[str],
    search_results: list[list[dict[str, Any]]],
    threshold: float,
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


def normalize_url(value: str) -> str:
    parts = urlsplit(value.strip())
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return ""
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, parts.query, ""))


def url_key(value: str) -> str:
    return normalize_url(value).casefold()


def record_id(url: str) -> str:
    return hashlib.sha256(url_key(url).encode("utf-8")).hexdigest()
