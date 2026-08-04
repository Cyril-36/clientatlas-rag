"""Application factory for the ClientAtlas model service."""

from __future__ import annotations

from fastapi import FastAPI

from app import __version__
from app.api import health, ingestion, metrics


def create_app() -> FastAPI:
    """Build the FastAPI application.

    A factory rather than a module-level singleton so tests can construct an
    isolated instance without importing process-wide state.
    """
    app = FastAPI(
        title="ClientAtlas AI",
        version=__version__,
        description=(
            "Parses documents, embeds text and generates grounded answers. "
            "Holds no tenant database access by design."
        ),
    )

    app.include_router(health.router)
    app.include_router(ingestion.router)
    app.include_router(metrics.router)

    return app


app = create_app()
