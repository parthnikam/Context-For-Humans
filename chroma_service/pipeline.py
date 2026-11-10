"""The categorization and clustering pipeline behind the /cluster endpoint."""

from __future__ import annotations

from typing import Any

from chroma_service import chroma_store
from chroma_service.categories import CATEGORIES, CATEGORY_BY_ID
from chroma_service.config import TYPESAFE_MODEL
from chroma_service.models import Conversation
from chroma_service.typesafe_client import classify_titles_with_typesafe


def cluster_conversations(
    conversations: list[Conversation],
    similarity_threshold: float,
) -> dict[str, Any]:
    """Categorize every title with Jev, then cluster similar titles per category."""
    unique_by_url: dict[str, Conversation] = {}
    for conversation in conversations:
        title = conversation.title.strip()
        url = chroma_store.normalize_url(conversation.url)
        if not title or not url:
            continue
        key = chroma_store.url_key(url)
        unique_by_url[key] = Conversation(title=title, url=url)
    unique = list(unique_by_url.values())
    if not unique:
        raise ValueError("No unique valid conversations were provided.")

    record_ids = [chroma_store.record_id(conversation.url) for conversation in unique]
    incoming_ids = set(record_ids)

    stored_metadata = chroma_store.get_stored_metadata(record_ids)
    categories_by_index: dict[int, dict[str, str]] = {}
    uncategorized_indices = [
        index for index, item_id in enumerate(record_ids)
        if (
            stored_metadata.get(item_id, {}).get("category_id") not in CATEGORY_BY_ID
            or stored_metadata.get(item_id, {}).get("title") != unique[index].title
        )
    ]
    if uncategorized_indices:
        classified = classify_titles_with_typesafe(
            [unique[index].title for index in uncategorized_indices],
        )
        categories_by_index.update(zip(uncategorized_indices, classified))
    for index, item_id in enumerate(record_ids):
        stored_record = stored_metadata.get(item_id, {})
        stored_category_id = stored_record.get("category_id")
        if (
            stored_category_id in CATEGORY_BY_ID
            and stored_record.get("title") == unique[index].title
        ):
            category_name, _ = CATEGORY_BY_ID[stored_category_id]
            categories_by_index[index] = {
                "category_id": stored_category_id,
                "category_name": category_name,
            }

    metadata = []
    for index, conversation in enumerate(unique):
        existing = stored_metadata.get(record_ids[index], {})
        category = categories_by_index[index]
        metadata.append({
            "url": conversation.url,
            "title": conversation.title,
            "project_id": str(existing.get("project_id", "")),
            "project_name": str(existing.get("project_name", "")),
            "category_id": category["category_id"],
            "category_name": category["category_name"],
        })

    flat_results, total_count = chroma_store.index_and_query(unique, record_ids, metadata)

    clusters = chroma_store.build_clusters(
        unique,
        record_ids,
        incoming_ids,
        flat_results,
        similarity_threshold,
        categories_by_index,
    )
    return {
        "clusters": clusters,
        "categorization": {
            "model": TYPESAFE_MODEL,
            "category_count": len(CATEGORIES),
            "titles": [
                {
                    "title": conversation.title,
                    **categories_by_index[index],
                }
                for index, conversation in enumerate(unique)
            ],
        },
        "indexed_titles": len(unique),
        "stored_titles": total_count,
        "similarity_threshold": similarity_threshold,
    }
