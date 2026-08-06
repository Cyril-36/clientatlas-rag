"""Generation providers.

The same shape as the embedding providers: one protocol, a real implementation
and a deterministic one. The deterministic provider is not a mock in a test
file — it is a supported provider named in the contract, because CI needs to
exercise the whole streaming and citation path without an 8B model, and a
substitute that only exists under `if TESTING` is a substitute nobody runs.

Nothing here reaches the database. That is the F1 boundary, and a test fails
the build if a driver is ever imported into this service.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Iterable
from typing import Protocol, runtime_checkable

import httpx

from app.generation.prompt import ABSTENTION_MARKER, SYSTEM_PROMPT, Passage, build_prompt


class GenerationUnavailableError(RuntimeError):
    """The requested generation backend could not be reached."""


@runtime_checkable
class GenerationProvider(Protocol):
    """Turns a question and evidence into a stream of answer tokens."""

    @property
    def model_name(self) -> str: ...

    def generate(
        self,
        question: str,
        passages: list[Passage],
        *,
        max_output_tokens: int,
        temperature: float,
    ) -> AsyncIterator[str]: ...


def _sentences(text: str) -> list[str]:
    """Split into sentences well enough to quote one back."""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [part.strip() for part in parts if part.strip()]


class DeterministicProvider:
    """Extractive, model-free, and completely predictable.

    It answers by quoting the passage with the most word overlap with the
    question and citing it, and abstains when the overlap is zero. That makes
    it a poor writer and an excellent test subject: every property the caller
    enforces — citations that resolve, an abstention marker, tokens arriving in
    a stream — is exercised end to end without a model, and the expected output
    is computable in the test rather than approximated.

    It must never answer a real question. The response reports which provider
    ran, and the caller refuses to store an answer from this one.
    """

    @property
    def model_name(self) -> str:
        return "deterministic-demo"

    async def generate(
        self,
        question: str,
        passages: list[Passage],
        *,
        max_output_tokens: int,
        temperature: float,
    ) -> AsyncIterator[str]:
        del max_output_tokens, temperature  # Deliberately ignored; nothing samples.

        best: tuple[int, Passage] | None = None
        asked = _words(question)

        for passage in passages:
            overlap = len(asked & _words(passage.text))
            if best is None or overlap > best[0]:
                best = (overlap, passage)

        if best is None or best[0] == 0:
            yield ABSTENTION_MARKER
            return

        passage = best[1]
        sentences = _sentences(passage.text)
        sentence = sentences[0] if sentences else passage.text

        # Emitted in pieces, because a provider that returns one string would
        # let a broken stream implementation pass its tests.
        for token in _tokenise(f"{sentence} [{passage.ordinal}]"):
            yield token


_STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "do",
        "does",
        "for",
        "from",
        "how",
        "i",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "that",
        "the",
        "to",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "with",
        "you",
        "your",
    ]
)


def _words(text: str) -> set[str]:
    return {word for word in re.findall(r"[a-z0-9]+", text.lower()) if word not in _STOPWORDS}


def _tokenise(text: str) -> Iterable[str]:
    """Whitespace-preserving split, so re-joining the stream restores the text."""
    return (match.group(0) for match in re.finditer(r"\S+\s*", text))


class OllamaProvider:
    """Streams from an Ollama server on the host.

    Ollama runs natively rather than in Docker because a Linux container on
    Apple Silicon gets no GPU access and silently falls back to CPU, which
    turns a two-second answer into a two-minute one.
    """

    def __init__(self, base_url: str, model: str, timeout_seconds: float = 120.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._timeout = timeout_seconds

    @property
    def model_name(self) -> str:
        return self._model

    async def generate(
        self,
        question: str,
        passages: list[Passage],
        *,
        max_output_tokens: int,
        temperature: float,
    ) -> AsyncIterator[str]:
        payload = {
            "model": self._model,
            "system": SYSTEM_PROMPT,
            "prompt": build_prompt(question, passages),
            "stream": True,
            "options": {
                "temperature": temperature,
                "num_predict": max_output_tokens,
            },
        }

        try:
            async with (
                httpx.AsyncClient(timeout=self._timeout) as client,
                client.stream("POST", f"{self._base_url}/api/generate", json=payload) as response,
            ):
                if response.status_code != 200:
                    await response.aread()
                    raise GenerationUnavailableError(
                        f"ollama returned {response.status_code} for model {self._model}"
                    )

                async for line in response.aiter_lines():
                    if not line.strip():
                        continue

                    try:
                        frame = json.loads(line)
                    except json.JSONDecodeError:
                        # A malformed frame is not worth failing a whole answer
                        # over, but silently dropping every frame would look
                        # like an empty answer, which the caller treats as an
                        # abstention. Skipping one is the smaller lie.
                        continue

                    chunk = frame.get("response")
                    if chunk:
                        yield chunk

                    if frame.get("done"):
                        return
        except httpx.HTTPError as error:
            raise GenerationUnavailableError(f"could not reach ollama: {error}") from error
