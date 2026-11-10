"""Ask agent: an OpenAI tool-calling loop over Mem0 memories and filed conversations."""

from __future__ import annotations

import json
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

EMPTY_MEMORY = "oops. i don't have that in my memory"
MAX_ROUNDS = 4

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_memory",
            "description": "Search remembered projects and filed work. Use this for questions about past work.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The question as the user asked it. Do not reduce it to keywords they already used.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_conversations",
            "description": "Search the filed conversation titles and projects by meaning. Use this to find what was filed about a topic.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The topic or question as the user asked it.",
                    },
                },
                "required": ["query"],
            },
        },
    },
]


def build_agent_prompt() -> str:
    return "\n".join([
        "You are the memory for this person's chat projects.",
        "A project keeps its conversations after the browser is closed.",
        "Use a tool when you need facts. Do not invent saved links.",
        "search_memory answers questions about what they filed and remembered.",
        "search_conversations searches the filed conversation titles and projects by meaning.",
        "A question can match a project even when it does not reuse that project's words. Pass the question as asked.",
        f"If the searches find nothing, answer exactly: {EMPTY_MEMORY}",
        "Do not answer a memory question from general knowledge.",
        "Then answer in one short paragraph and name the project.",
    ])


def answer_question(question: str, user_id: str | None = None) -> dict[str, Any]:
    question = (question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="The question cannot be empty.")
    api_key = load_openai_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY was not found in the service environment or chrome_extension/.env.",
        )
    messages = [
        {"role": "system", "content": build_agent_prompt()},
        {"role": "user", "content": question},
    ]
    sources: list[dict[str, str]] = []
    projects: set[str] = set()
    searched = False
    found = False
    answer = ""
    for round_index in range(MAX_ROUNDS + 1):
        force_answer = round_index == MAX_ROUNDS
        body = {
            "model": OPENAI_MODEL,
            "messages": messages,
            "reasoning_effort": "none",
            "max_completion_tokens": 800,
        }
        if not force_answer:
            body["tools"] = AGENT_TOOLS
            body["tool_choice"] = "auto"
        try:
            response = requests.post(
                OPENAI_CHAT_COMPLETIONS_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json=body,
                timeout=90,
            )
        except requests.RequestException as error:
            raise HTTPException(status_code=502, detail="Could not reach the OpenAI API.") from error
        if not response.ok:
            raise openai_client.openai_http_error(response, api_key)
        try:
            message = response.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise HTTPException(status_code=502, detail="OpenAI returned an invalid answer.") from error
        tool_calls = message.get("tool_calls") or []
        answer = str(message.get("content") or "").strip()
        if not tool_calls:
            break
        messages.append(message)
        for call in tool_calls:
            function = call.get("function") or {}
            name = str(function.get("name") or "")
            try:
                args = json.loads(function.get("arguments") or "{}")
            except ValueError:
                args = {}
            if not isinstance(args, dict):
                args = {}
            payload = _call_tool(name, args, user_id)
            if name == "search_memory" and not payload.get("error"):
                searched = True
                if payload.get("found"):
                    found = True
            if name == "search_conversations" and not payload.get("error"):
                searched = True
                if payload.get("conversations"):
                    found = True
                    for conversation in payload["conversations"]:
                        url = str(conversation.get("url") or "").strip()
                        if url and not any(source["url"] == url for source in sources):
                            sources.append({
                                "title": str(conversation.get("title") or url),
                                "url": url,
                            })
            for project_name in payload.get("projects") or []:
                if project_name:
                    projects.add(project_name)
            messages.append({
                "role": "tool",
                "tool_call_id": str(call.get("id") or ""),
                "content": json.dumps(payload, ensure_ascii=False),
            })
    if searched and not found:
        answer = EMPTY_MEMORY
    if not answer:
        answer = EMPTY_MEMORY if searched else "Nothing filed matches that."
    return {
        "answer": answer,
        "model": OPENAI_MODEL,
        "sources": sources,
        "projects": sorted(projects),
    }


def _call_tool(name: str, args: dict[str, Any], user_id: str | None) -> dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        return {"error": "The query cannot be empty."}
    if name == "search_memory":
        memories = mem0_client.search_memories(
            query,
            user_id=user_id or mem0_client.DEFAULT_USER_ID,
        )
        return {"memories": memories, "found": bool(memories)}
    if name == "search_conversations":
        matches = chroma_store.search_matches(query, 12)
        conversations = [
            {
                "title": str(match.get("title") or ""),
                "url": str(match.get("url") or ""),
                "project": str(match.get("project_name") or ""),
            }
            for match in matches
        ]
        project_names: list[str] = []
        seen: set[str] = set()
        for match in matches:
            project_name = str(match.get("project_name") or "").strip()
            if project_name and project_name not in seen:
                seen.add(project_name)
                project_names.append(project_name)
        return {"conversations": conversations, "projects": project_names}
    return {"error": f"Unknown tool {name}."}


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
