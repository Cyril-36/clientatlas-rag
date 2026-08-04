"""Service configuration.

Every value has a safe local default except the ones that would send content off
the machine. Those default to the closed position and must be opted into.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIMENSIONS = 384


class Settings(BaseSettings):
    """Runtime settings, read from `CLIENTATLAS_AI_*` environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="CLIENTATLAS_AI_",
        env_file=".env",
        extra="ignore",
    )

    mode: Literal["local", "demo"] = "local"

    embedding_model: str = EMBEDDING_MODEL
    embedding_dimensions: int = EMBEDDING_DIMENSIONS

    # "minilm" loads the real model; "deterministic" produces correctly shaped
    # but meaningless vectors for tests and CI. The response reports whichever
    # actually ran, and the Node contract pins the model name to a literal — so
    # deterministic vectors are refused rather than silently stored.
    embedding_provider: Literal["minilm", "deterministic"] = "minilm"

    # Ollama runs natively on the host rather than in Docker: a Linux container
    # on Apple Silicon gets no GPU access and would fall back to CPU inference.
    ollama_base_url: str = "http://localhost:11434"
    generation_model: str = "qwen3:8b"

    # Hosted generation is only ever legitimate for workspaces explicitly marked
    # synthetic. Defaulting this to False means a misconfiguration fails closed:
    # the service refuses to call out rather than silently shipping a document
    # to a third party.
    allow_hosted_providers: bool = False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings, constructed once."""
    return Settings()
