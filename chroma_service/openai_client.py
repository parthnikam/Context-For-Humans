"""OpenAI client: names clusters, reuses projects, and clusters open tabs."""

from __future__ import annotations

import json
from typing import Any

import requests
from fastapi import HTTPException

from chroma_service.config import (
    OPENAI_CHAT_COMPLETIONS_URL,
    OPENAI_MODEL,
    load_openai_api_key,
)
from chroma_service.models import TabClusterRequest
from chroma_service.models import ProjectAssignmentRequest

OPENAI_ASSIGNMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "assignments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cluster_id": {"type": "string"},
                    "existing_project_id": {"type": "string"},
                    "project_name": {"type": "string"},
                    "intent": {"type": "string"},
                },
                "required": ["cluster_id", "existing_project_id", "project_name", "intent"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["assignments"],
    "additionalProperties": False,
}


def test_openai_connection() -> dict[str, str | bool]:
    api_key = load_openai_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY was not found in the service environment or chrome_agent/.env.",
        )
    try:
        response = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": OPENAI_MODEL,
                "messages": [{"role": "user", "content": 'Return a JSON object with the boolean property "ok" set to true.'}],
                "response_format": {"type": "json_object"},
                "reasoning_effort": "none",
                "max_completion_tokens": 64,
            },
            timeout=30,
        )
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not reach the OpenAI API.") from error
    if not response.ok:
        raise openai_http_error(response, api_key)
    try:
        result = response.json()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="OpenAI returned an invalid response.") from error
    if not chat_completion_text(result):
        raise HTTPException(status_code=502, detail="OpenAI returned no test response.")
    return {"ok": True, "model": OPENAI_MODEL}


def assign_projects_with_openai(request: ProjectAssignmentRequest) -> dict[str, Any]:
    api_key = load_openai_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY was not found in the service environment or chrome_agent/.env.",
        )

    existing_ids = {
        str(project.get("id", ""))
        for project in request.existing_projects
        if project.get("id")
    }
    existing_categories = {
        str(project.get("id")): str(project.get("category_id", ""))
        for project in request.existing_projects
        if project.get("id")
    }
    incoming_by_id: dict[str, dict[str, Any]] = {}
    for cluster in request.incoming_clusters:
        cluster_id = str(cluster.get("cluster_id", ""))
        if not cluster_id or cluster_id in incoming_by_id:
            raise HTTPException(status_code=400, detail="Incoming clusters must have unique non-empty IDs.")
        incoming_by_id[cluster_id] = cluster

    system_prompt = "\n".join([
        "You organize chat conversation titles into durable projects.",
        "Incoming clusters were formed by a persistent local ChromaDB vector index. Their membership is fixed.",
        "For every incoming cluster, assign it to exactly one existing project or create a new project.",
        "Never split, merge, or move conversations between incoming clusters.",
        "Reuse an existing project only when its name, representative titles, and similarity evidence clearly indicate the same ongoing work.",
        "Every cluster includes a category. Reuse only a project with the exact same category_id.",
        "Treat provider-specific wording as weak evidence: the same chatbot provider can contain unrelated projects.",
        "When reusing a project, return its exact existing_project_id, and set project_name and intent to empty strings.",
        "When creating a project, set existing_project_id to an empty string and provide a concise specific project_name and one-sentence intent.",
        "Never invent a project ID. Return exactly one assignment per incoming cluster.",
        "Copy every cluster_id exactly from the input.",
    ])
    assignments = request_openai_assignment(
        api_key,
        system_prompt,
        request.existing_projects,
        list(incoming_by_id.values()),
    )

    missing_names = [
        assignment for assignment in assignments
        if isinstance(assignment, dict)
        and not assignment.get("existing_project_id")
        and not str(assignment.get("project_name", "")).strip()
    ]
    if missing_names:
        retry_ids = {str(assignment.get("cluster_id", "")) for assignment in missing_names}
        retry_clusters = [
            cluster for cluster_id, cluster in incoming_by_id.items()
            if cluster_id in retry_ids
        ]
        retry_assignments = request_openai_assignment(
            api_key,
            system_prompt,
            request.existing_projects,
            retry_clusters,
            retry=True,
        )
        retry_by_id = {
            str(assignment.get("cluster_id", "")): assignment
            for assignment in retry_assignments
            if isinstance(assignment, dict)
        }
        assignments = [
            retry_by_id.get(str(assignment.get("cluster_id", "")), assignment)
            if isinstance(assignment, dict)
            else assignment
            for assignment in assignments
        ]

    assignments_by_id: dict[str, dict[str, str]] = {}
    for assignment in assignments:
        if not isinstance(assignment, dict):
            raise HTTPException(status_code=502, detail="OpenAI returned an invalid project assignment.")
        cluster_id = str(assignment.get("cluster_id", ""))
        if cluster_id not in incoming_by_id or cluster_id in assignments_by_id:
            raise HTTPException(status_code=502, detail="OpenAI returned a missing, unknown, or duplicate cluster ID.")
        existing_project_id = str(assignment.get("existing_project_id", ""))
        if existing_project_id and existing_project_id not in existing_ids:
            raise HTTPException(status_code=502, detail="OpenAI selected an unknown existing project.")
        if existing_project_id and (
            existing_categories.get(existing_project_id)
            != str(incoming_by_id[cluster_id].get("category_id", ""))
        ):
            raise HTTPException(status_code=502, detail="OpenAI selected a project from a different category.")
        project_name = str(assignment.get("project_name", "")).strip()
        intent = str(assignment.get("intent", "")).strip()
        if not existing_project_id and not project_name:
            raise HTTPException(status_code=502, detail=f"OpenAI did not name new cluster {cluster_id}.")
        assignments_by_id[cluster_id] = {
            "cluster_id": cluster_id,
            "existing_project_id": existing_project_id,
            "project_name": project_name,
            "intent": intent,
        }

    return {
        "model": OPENAI_MODEL,
        "assignments": [assignments_by_id[cluster_id] for cluster_id in incoming_by_id],
    }


def request_openai_assignment(
    api_key: str,
    system_prompt: str,
    existing_projects: list[dict[str, Any]],
    incoming_clusters: list[dict[str, Any]],
    retry: bool = False,
) -> list[dict[str, Any]]:
    prompt = system_prompt
    if retry:
        prompt = (
            system_prompt
            + "\nFor every new project, project_name MUST be a non-empty, concise title. "
            + "Use the incoming titles to name it; do not return blank fields."
        )
    try:
        response = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": OPENAI_MODEL,
                "messages": [
                    {"role": "system", "content": prompt},
                    {
                        "role": "user",
                        "content": json.dumps({
                            "existing_projects": existing_projects,
                            "incoming_clusters": incoming_clusters,
                        }, ensure_ascii=False),
                    },
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "project_assignments",
                        "strict": True,
                        "schema": OPENAI_ASSIGNMENT_SCHEMA,
                    },
                },
                "reasoning_effort": "none",
                "max_completion_tokens": 4096,
            },
            timeout=90,
        )
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not reach the OpenAI project assignment API.") from error
    if not response.ok:
        raise openai_http_error(response, api_key)
    try:
        result = response.json()
        content = chat_completion_text(result)
        parsed = json.loads(content) if content else {}
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=502, detail="OpenAI returned invalid project assignments.") from error
    assignments = parsed.get("assignments") if isinstance(parsed, dict) else None
    if not isinstance(assignments, list):
        raise HTTPException(status_code=502, detail="OpenAI returned invalid project assignments.")
    return assignments


def chat_completion_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    return content if isinstance(content, str) else ""


def openai_http_error(response: requests.Response, api_key: str) -> HTTPException:
    try:
        detail = response.json().get("error", {}).get("message", "")
    except (ValueError, AttributeError):
        detail = ""
    if detail:
        detail = str(detail).replace(api_key, "[redacted]")
    message = f"OpenAI API request failed ({response.status_code})."
    if detail:
        message = f"{message} {detail}"
    return HTTPException(status_code=502, detail=message)


TAB_CLUSTER_SCHEMA = {
    "type": "object",
    "properties": {
        "trails": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "one_liner": {"type": "string"},
                    "tab_ids": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["label", "one_liner", "tab_ids"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["trails"],
    "additionalProperties": False,
}


def build_tab_cluster_prompt(request: TabClusterRequest) -> str:
    payload = [
        {"id": tab.id, "title": tab.title, "url": tab.url}
        for tab in request.tabs
    ]
    known = [
        {"name": project.name, "intent": project.intent}
        for project in request.projects
        if project.name
    ]
    rules = [
        "- Group by task, not by website. Two GitHub tabs can be different projects. A docs tab and a forum tab can be the same project.",
        "- Put every tab id in exactly one trail.",
        "- label is a short project name.",
        "- one_liner is one sentence the person can read to remember what that pile of tabs is for.",
    ]
    if known:
        rules.append("- If the tabs belong to an existing project, label must be that project's name exactly.")
        rules.append("- Invent a new label only when none of the existing projects fit.")
    lines = [
        "Group these open browser tabs into the projects the person is working on.",
        "",
        "Rules:",
        *rules,
        "",
        "Tabs:",
        json.dumps(payload, ensure_ascii=False),
    ]
    if known:
        lines.extend(["", "Existing projects:", json.dumps(known, ensure_ascii=False)])
    return "\n".join(lines)


def normalize_trails(raw_trails: Any, request: TabClusterRequest) -> list[dict[str, Any]]:
    known = {tab.id for tab in request.tabs}
    used: set[int] = set()
    trails: list[dict[str, Any]] = []
    for raw in raw_trails if isinstance(raw_trails, list) else []:
        if not isinstance(raw, dict):
            continue
        tab_ids: list[int] = []
        for value in raw.get("tab_ids") or []:
            try:
                numeric = int(value)
            except (TypeError, ValueError):
                continue
            if numeric not in known or numeric in used:
                continue
            used.add(numeric)
            tab_ids.append(numeric)
        if not tab_ids:
            continue
        trails.append({
            "label": str(raw.get("label") or "").strip() or "Untitled",
            "one_liner": str(raw.get("one_liner") or "").strip(),
            "tab_ids": tab_ids,
        })
    missing = [tab.id for tab in request.tabs if tab.id not in used]
    if missing:
        trails.append({
            "label": "Ungrouped",
            "one_liner": "These tabs did not fit another group.",
            "tab_ids": missing,
        })
    return trails


def cluster_tabs(request: TabClusterRequest) -> dict[str, Any]:
    api_key = load_openai_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY was not found in the service environment or chrome_agent/.env.",
        )
    try:
        response = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": OPENAI_MODEL,
                "messages": [
                    {"role": "system", "content": "You organize open browser tabs into the projects they belong to."},
                    {"role": "user", "content": build_tab_cluster_prompt(request)},
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "tab_trails",
                        "strict": True,
                        "schema": TAB_CLUSTER_SCHEMA,
                    },
                },
                "reasoning_effort": "none",
                "max_completion_tokens": 4096,
            },
            timeout=90,
        )
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not reach the OpenAI tab clustering API.") from error
    if not response.ok:
        raise openai_http_error(response, api_key)
    try:
        result = response.json()
        content = chat_completion_text(result)
        parsed = json.loads(content) if content else {}
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=502, detail="OpenAI returned invalid tab clusters.") from error
    trails = parsed.get("trails") if isinstance(parsed, dict) else None
    if not isinstance(trails, list):
        raise HTTPException(status_code=502, detail="OpenAI returned invalid tab clusters.")
    return {
        "model": OPENAI_MODEL,
        "trails": normalize_trails(trails, request),
    }
