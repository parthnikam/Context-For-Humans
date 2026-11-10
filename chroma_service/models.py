"""Pydantic request models for the FastAPI endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Conversation(BaseModel):
    title: str = Field(min_length=1, max_length=1000)
    url: str = Field(min_length=1, max_length=4096)


class ClusterRequest(BaseModel):
    conversations: list[Conversation] = Field(min_length=1, max_length=2000)
    similarity_threshold: float = Field(default=0.62, ge=0, le=1)


class Assignment(BaseModel):
    url: str = Field(min_length=1, max_length=4096)
    title: str = Field(min_length=1, max_length=1000)
    project_id: str = Field(min_length=1, max_length=200)
    project_name: str = Field(min_length=1, max_length=200)
    category_id: str = Field(default="uncategorized", min_length=1, max_length=100)
    category_name: str = Field(default="Uncategorized", min_length=1, max_length=200)


class AssignmentRequest(BaseModel):
    assignments: list[Assignment] = Field(min_length=1, max_length=2000)


class ProjectAssignmentRequest(BaseModel):
    existing_projects: list[dict[str, Any]] = Field(max_length=1000)
    incoming_clusters: list[dict[str, Any]] = Field(min_length=1, max_length=25)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=12, ge=1, le=50)
