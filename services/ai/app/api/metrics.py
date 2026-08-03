"""Prometheus exposition endpoint.

M1 exposes build and configuration information only. The latency, token-count
and provider-call metrics described in the observability plan are added
alongside the components that produce them, so this endpoint never reports a
metric that nothing is actually measuring.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse

from app import __version__
from app.config import Settings, get_settings

router = APIRouter(tags=["observability"])

SettingsDep = Annotated[Settings, Depends(get_settings)]

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


@router.get("/metrics", response_class=PlainTextResponse)
def metrics(settings: SettingsDep) -> PlainTextResponse:
    """Expose build info in Prometheus text exposition format."""
    body = "\n".join(
        [
            "# HELP clientatlas_ai_build_info Build and configuration information.",
            "# TYPE clientatlas_ai_build_info gauge",
            (
                f'clientatlas_ai_build_info{{version="{__version__}",'
                f'mode="{settings.mode}",'
                f'embedding_model="{settings.embedding_model}",'
                f'generation_model="{settings.generation_model}"}} 1'
            ),
            "# HELP clientatlas_ai_hosted_providers_allowed Whether hosted generation is allowed.",
            "# TYPE clientatlas_ai_hosted_providers_allowed gauge",
            f"clientatlas_ai_hosted_providers_allowed {int(settings.allow_hosted_providers)}",
            "",
        ]
    )

    return PlainTextResponse(content=body, media_type=CONTENT_TYPE)
