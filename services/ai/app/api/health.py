"""Liveness and readiness probes."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel

from app.config import Settings, get_settings

router = APIRouter(tags=["health"])

SettingsDep = Annotated[Settings, Depends(get_settings)]


class LivenessResponse(BaseModel):
    """The process is up and serving requests."""

    status: Literal["ok"]
    service: Literal["ai"]


class ReadinessResponse(BaseModel):
    """The process is configured well enough to accept work.

    `checks` reports what is wired, not what has been proven to work. Model
    loading and a live Ollama probe arrive with the embedding and generation
    providers in M4 and M5; until then this endpoint must not imply otherwise.
    """

    status: Literal["ok", "degraded"]
    mode: Literal["local", "demo"]
    checks: dict[str, bool]


@router.get("/health/live")
def live() -> LivenessResponse:
    """Report process liveness without touching any dependency."""
    return LivenessResponse(status="ok", service="ai")


@router.get("/health/ready")
def ready(settings: SettingsDep, response: Response) -> ReadinessResponse:
    """Report whether required configuration is present."""
    checks = {
        "embedding_model_configured": bool(settings.embedding_model),
        "embedding_dimensions_valid": settings.embedding_dimensions > 0,
        "generation_backend_configured": bool(settings.ollama_base_url)
        and bool(settings.generation_model),
    }

    healthy = all(checks.values())
    if not healthy:
        response.status_code = 503

    return ReadinessResponse(
        status="ok" if healthy else "degraded",
        mode=settings.mode,
        checks=checks,
    )
