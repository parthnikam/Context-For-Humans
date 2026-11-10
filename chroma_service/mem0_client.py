"""Mem0 Platform client: remembers filed projects and retrieves memories."""

from __future__ import annotations

from typing import Any

import requests
from fastapi import HTTPException

from chroma_service.config import load_mem0_api_key

MEM0_HOST = "https://api.mem0.ai"
DEFAULT_USER_ID = "local-user"
MEM0_APP_ID = "context-for-humans"
MEM0_TIMEOUT = 30


def test_mem0_connection() -> dict[str, bool]:
    api_key = load_mem0_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="MEM0_API_KEY (or MEMO_API_KEY) was not found in the service environment or chrome_extension/.env.",
        )
    try:
        response = requests.get(
            f"{MEM0_HOST}/v1/ping/",
            headers=_headers(api_key),
            timeout=MEM0_TIMEOUT,
        )
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not reach Mem0.") from error
    if not response.ok:
        raise HTTPException(status_code=502, detail=f"Mem0 request failed ({response.status_code}).")
    return {"ok": True}


def add_memories(entries: list[dict[str, Any]], user_id: str = DEFAULT_USER_ID) -> int:
    api_key = load_mem0_api_key()
    if not api_key or not entries:
        return 0
    added = 0
    for entry in entries:
        try:
            response = requests.post(
                f"{MEM0_HOST}/v3/memories/add/",
                headers=_headers(api_key),
                json={
                    "messages": [{"role": "user", "content": entry["content"]}],
                    "user_id": user_id,
                    "app_id": MEM0_APP_ID,
                    "metadata": entry.get("metadata", {}),
                },
                timeout=MEM0_TIMEOUT,
            )
        except requests.RequestException:
            continue
        if response.ok:
            added += 1
    return added


def search_memories(
    query: str,
    limit: int = 6,
    user_id: str = DEFAULT_USER_ID,
) -> list[str]:
    api_key = load_mem0_api_key()
    if not api_key:
        return []
    try:
        response = requests.post(
            f"{MEM0_HOST}/v3/memories/search/",
            headers=_headers(api_key),
            json={"query": query, "filters": {"user_id": user_id}},
            timeout=MEM0_TIMEOUT,
        )
    except requests.RequestException:
        return []
    if not response.ok:
        return []
    try:
        data = response.json()
    except ValueError:
        return []
    results = data.get("results") if isinstance(data, dict) else data
    if not isinstance(results, list):
        return []
    return [
        str(row.get("memory"))
        for row in results
        if isinstance(row, dict) and row.get("memory")
    ][:limit]


def _headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Token {api_key}", "Content-Type": "application/json"}
