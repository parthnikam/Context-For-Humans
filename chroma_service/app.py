"""FastAPI application: thin routes over the config, clients, store, and pipeline.

Run with: python -m uvicorn chroma_service.app:app --host 127.0.0.1 --port 8760
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from chroma_service import chroma_store, config, mem0_client, openai_client, pipeline, qa
from chroma_service.categories import CATEGORIES
from chroma_service.models import (
    AskRequest,
    AssignmentRequest,
    ClusterRequest,
    ExistingConversationsRequest,
    ProjectAssignmentRequest,
    SearchRequest,
    TabClusterRequest,
)
from chroma_service.typesafe_client import classify_titles_with_typesafe

app = FastAPI(title="Context For Humans Chroma Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "collection": config.COLLECTION_NAME,
        "stored_titles": chroma_store.count(),
        "data_directory": str(config.DATA_DIR),
        "openai_configured": bool(config.load_openai_api_key()),
        "openai_model": config.OPENAI_MODEL,
        "typesafe_configured": bool(config.load_typesafe_api_key()),
        "typesafe_model": config.TYPESAFE_MODEL,
        "category_count": len(CATEGORIES),
    }


@app.get("/categories")
def list_categories() -> dict:
    return {
        "categories": [
            {"id": category_id, "name": name, "description": description}
            for category_id, name, description in CATEGORIES
        ],
    }


@app.post("/typesafe-test")
def test_typesafe() -> dict:
    api_key = config.load_typesafe_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="TYPESAFE_API_KEY was not found in the service environment or chrome_extension/.env.",
        )
    categories = classify_titles_with_typesafe(["A question about writing Python code."], api_key)
    return {
        "ok": True,
        "model": config.TYPESAFE_MODEL,
        "category": categories[0]["category_name"],
    }


@app.post("/openai-test")
def test_openai() -> dict:
    return openai_client.test_openai_connection()


@app.post("/mem0-test")
def test_mem0() -> dict:
    return mem0_client.test_mem0_connection()


@app.post("/ask")
def ask(request: AskRequest) -> dict:
    return qa.answer_question(request.question, request.user_id)


@app.post("/cluster")
def cluster_titles(request: ClusterRequest) -> dict:
    try:
        return pipeline.cluster_conversations(
            request.conversations,
            request.similarity_threshold,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/existing-conversations")
def existing_conversations(request: ExistingConversationsRequest) -> dict:
    return {"existing_urls": chroma_store.get_existing_urls(request.urls)}


@app.post("/cluster-tabs")
def cluster_tabs(request: TabClusterRequest) -> dict:
    return openai_client.cluster_tabs(request)


@app.post("/assign-projects")
def assign_projects(request: ProjectAssignmentRequest) -> dict:
    return openai_client.assign_projects_with_openai(request)


@app.post("/assign")
def assign_projects_metadata(request: AssignmentRequest) -> dict:
    updated = chroma_store.apply_assignments(request.assignments)
    memorized = qa.remember_projects(request.assignments)
    return {"updated": updated, "memorized": memorized}


@app.post("/search")
def search_titles(request: SearchRequest) -> dict:
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Search query cannot be empty.")
    return {"query": query, "matches": chroma_store.search_matches(query, request.limit)}


@app.post("/clear")
def clear_index() -> dict:
    chroma_store.clear_collection()
    return {"cleared": True}
