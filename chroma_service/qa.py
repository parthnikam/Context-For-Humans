"""Question answering over filed projects using Mem0 memories and ChromaDB matches."""

from __future__ import annotations

from datetime import date
from typing import Any

import requests
from fastapi import HTTPException

from chroma_service import chroma_store, mem0_client, openai_client
from chroma_service.config import (
    OPENAI_CHAT_COMPLETIONS_URL,
    OPENAI_MODEL,
    load_openai_api_key,
)
from chroma_service.models import Assignment


def answer_question(question: str, user_id: str | None = None) -> dict[str, Any]:
    question = question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="The question cannot be empty.")
    memories = mem0_client.search_memories(
        question,
        user_id=user_id or mem0_client.DEFAULT_USER_ID,
    )
    matches = chroma_store.search_matches(question, 12)
    context_lines = [f"- remembered: {memory}" for memory in memories]
    for match in matches:
        project = match.get("project_name") or "unfiled"
        context_lines.append(f"- [{project}] {match.get('title', '')} ({match.get('url', '')})")
    context = "\n".join(context_lines) if context_lines else "(nothing filed yet)"

    api_key = load_openai_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY was not found in the service environment or chrome_agent/.env.",
        )
    system_prompt = "\n".join([
        "You answer questions about the user's saved chatbot conversation projects.",
        "Use only the context provided. It contains remembered project facts and semantically matched conversations.",
        "Name the projects you rely on. If the context cannot answer, say so and suggest what to file or ask instead.",
        "Answer in at most four short sentences.",
    ])
    try:
        response = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": OPENAI_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"},
                ],
                "reasoning_effort": "none",
                "max_completion_tokens": 500,
            },
            timeout=60,
        )
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not reach the OpenAI API.") from error
    if not response.ok:
        raise openai_client.openai_http_error(response, api_key)
    answer = openai_client.chat_completion_text(response.json()).strip()
    if not answer:
        raise HTTPException(status_code=502, detail="OpenAI returned no answer.")
    return {
        "answer": answer,
        "memories": memories,
        "matches": [
            {
                "title": match.get("title", ""),
                "url": match.get("url", ""),
                "project": match.get("project_name", ""),
            }
            for match in matches[:5]
        ],
    }


def remember_projects(assignments: list[Assignment]) -> int:
    try:
        grouped: dict[tuple[str, str, str, str], list[str]] = {}
        for item in assignments:
            key = (item.project_id, item.project_name.strip(), item.category_id, item.category_name.strip())
            grouped.setdefault(key, []).append(item.title.strip())
        today = date.today().isoformat()
        entries = []
        for (project_id, project_name, category_id, category_name), titles in grouped.items():
            entries.append({
                "content": (
                    f"On {today} the user filed the project '{project_name}' "
                    f"in the category '{category_name}'. "
                    f"It contains {len(titles)} conversation(s): {'; '.join(titles)}."
                ),
                "metadata": {
                    "kind": "project",
                    "project_id": project_id,
                    "category_id": category_id,
                    "saved_at": today,
                },
            })
        return mem0_client.add_memories(entries)
    except Exception:
        return 0
