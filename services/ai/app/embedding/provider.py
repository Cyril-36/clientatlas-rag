"""Embedding providers.

Two implementations behind one protocol.

`MiniLMProvider` is the real one. It loads sentence-transformers lazily, on
first use rather than at import, so starting the service does not pay for a
model nobody has asked for yet.

`DeterministicProvider` produces stable, correctly shaped vectors from a hash.
They carry no semantic meaning and must never be used to answer a real question
— what they are for is everything that needs *a* vector rather than a *good*
one: chunking tests, queue tests, CI. Keeping them out of the default path is
the reason the ML extra can stay optional and CI can stay fast.
"""

from __future__ import annotations

import hashlib
import math
import struct
from typing import Protocol, runtime_checkable

from app.config import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Turns text into fixed-width vectors."""

    @property
    def model_name(self) -> str: ...

    @property
    def dimensions(self) -> int: ...

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class EmbeddingUnavailableError(RuntimeError):
    """The real model was requested but its dependencies are not installed."""


class DeterministicProvider:
    """Hash-derived vectors: same input, same output, no model required."""

    def __init__(self, dimensions: int = EMBEDDING_DIMENSIONS) -> None:
        self._dimensions = dimensions

    @property
    def model_name(self) -> str:
        # Deliberately not the real model's name. A stored vector should never
        # be mistakable for one that came from MiniLM.
        return "deterministic-test-provider"

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        # Stretch the digest to the required width, then L2-normalise so cosine
        # distance behaves — the values are meaningless but the geometry is at
        # least well formed.
        raw = bytearray()
        counter = 0

        while len(raw) < self._dimensions * 4:
            digest = hashlib.sha256(f"{counter}:{text}".encode()).digest()
            raw.extend(digest)
            counter += 1

        values = [
            struct.unpack_from(">i", bytes(raw), offset * 4)[0] / 2**31
            for offset in range(self._dimensions)
        ]

        norm = math.sqrt(sum(value * value for value in values)) or 1.0
        return [value / norm for value in values]


class MiniLMProvider:
    """sentence-transformers/all-MiniLM-L6-v2, loaded on first use."""

    def __init__(self, model_name: str = EMBEDDING_MODEL) -> None:
        self._model_name = model_name
        self._model: object | None = None

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def dimensions(self) -> int:
        return EMBEDDING_DIMENSIONS

    def _load(self) -> object:
        if self._model is not None:
            return self._model

        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            raise EmbeddingUnavailableError(
                "sentence-transformers is not installed. Run `uv sync --extra ml` to "
                "embed for real, or use the deterministic provider for tests."
            ) from error

        self._model = SentenceTransformer(self._model_name)
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        model = self._load()
        # normalize_embeddings so cosine distance is a dot product, matching the
        # vector_cosine_ops index the chunks are stored under.
        vectors = model.encode(  # type: ignore[attr-defined]
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return [[float(value) for value in vector] for vector in vectors]
