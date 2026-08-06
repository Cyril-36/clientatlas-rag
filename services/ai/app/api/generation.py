"""The generation endpoint.

Implements the generation half of `packages/contracts/src/ai-service.ts`. Takes
a question and numbered evidence, streams back server-sent events.

Two things this endpoint does not do, both deliberate.

It does not decide what the evidence is. The caller retrieves under row-level
security and hands over passages; this service never sees a workspace id and
could not scope a query if it wanted to.

It does not have the last word on citations. It reports which ordinals it saw
in the text it produced, and the caller checks that against the evidence it
sent. A model service marking its own homework is not a guarantee, and the
`done` frame here is a convenience, not an authority.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from app.config import Settings, get_settings
from app.generation.prompt import ABSTENTION_MARKER, Passage
from app.generation.provider import (
    DeterministicProvider,
    GenerationProvider,
    GenerationUnavailableError,
    OllamaProvider,
)

router = APIRouter(tags=["generation"])

CITATION = re.compile(r"\[(\d+)\]")


class EvidenceItem(BaseModel):
    ordinal: int = Field(ge=1)
    chunk_id: str = Field(min_length=1, alias="chunkId")
    text: str = Field(min_length=1)
    document_title: str = Field(min_length=1, alias="documentTitle")
    page_number: int | None = Field(default=None, ge=1, alias="pageNumber")

    model_config = {"populate_by_name": True}


class GenerationPolicy(BaseModel):
    provider: Literal["local-ollama", "groq", "deterministic-demo"]
    max_output_tokens: int = Field(default=512, ge=64, le=2048, alias="maxOutputTokens")
    temperature: float = Field(default=0.1, ge=0.0, le=1.0)
    require_citations: bool = Field(default=True, alias="requireCitations")
    allow_hosted_provider: bool = Field(default=False, alias="allowHostedProvider")

    model_config = {"populate_by_name": True}


class GenerateRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    evidence: list[EvidenceItem] = Field(min_length=1, max_length=12)
    policy: GenerationPolicy

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def check_ordinals(self) -> GenerateRequest:
        """Ordinals must be unique and contiguous from 1.

        The same rule the TypeScript contract enforces, restated rather than
        trusted. A gap or a duplicate makes a citation ambiguous, and an
        ambiguous citation cannot be validated by the caller afterwards — so
        this is refused at the door rather than discovered later.
        """
        ordinals = [item.ordinal for item in self.evidence]

        if len(set(ordinals)) != len(ordinals):
            raise ValueError("evidence ordinals must be unique")

        if sorted(ordinals) != list(range(1, len(ordinals) + 1)):
            raise ValueError(f"evidence ordinals must be contiguous from 1 to {len(ordinals)}")

        return self


def _select_provider(policy: GenerationPolicy, settings: Settings) -> GenerationProvider:
    """Pick a provider, refusing the combinations that would leak content.

    Checked twice — here and in the TypeScript contract — because this is the
    boundary where private content would actually leave the machine. A check
    that exists only on the calling side protects nothing if anything else ever
    calls this endpoint.
    """
    if policy.provider == "groq":
        if not policy.allow_hosted_provider or not settings.allow_hosted_providers:
            raise HTTPException(
                status_code=403,
                detail=(
                    "hosted generation is not enabled. Confidential content must not "
                    "leave the local machine, and there is no fallback path to a "
                    "hosted provider from confidential mode."
                ),
            )
        raise HTTPException(status_code=501, detail="the hosted provider is not implemented")

    if policy.provider == "deterministic-demo":
        return DeterministicProvider()

    return OllamaProvider(settings.ollama_base_url, settings.generation_model)


def _event(payload: dict[str, object]) -> str:
    """One SSE frame.

    `json.dumps` rather than string building, because an answer containing a
    newline would otherwise split into two frames and the second would be
    parsed as a new event.
    """
    return f"data: {json.dumps(payload)}\n\n"


async def _stream(
    provider: GenerationProvider,
    request: GenerateRequest,
) -> AsyncIterator[str]:
    passages = [
        Passage(
            ordinal=item.ordinal,
            text=item.text,
            document_title=item.document_title,
            page_number=item.page_number,
        )
        for item in request.evidence
    ]

    pieces: list[str] = []

    try:
        async for chunk in provider.generate(
            request.question,
            passages,
            max_output_tokens=request.policy.max_output_tokens,
            temperature=request.policy.temperature,
        ):
            pieces.append(chunk)
            yield _event({"type": "token", "text": chunk})
    except GenerationUnavailableError as error:
        yield _event({"type": "error", "code": "generation_unavailable", "message": str(error)})
        return

    answer = "".join(pieces)

    # Abstention is decided on the assembled text, not per chunk: the marker
    # arrives in pieces like anything else, and a token-by-token check would
    # never see it whole.
    if ABSTENTION_MARKER in answer:
        yield _event(
            {
                "type": "abstained",
                "reason": "the evidence provided does not answer the question",
            }
        )
        return

    cited = sorted({int(match) for match in CITATION.findall(answer)})
    known = {item.ordinal for item in request.evidence}
    resolvable = [ordinal for ordinal in cited if ordinal in known]

    # An answer with no citation it can support is not an answer. Saying so
    # here costs a round trip; letting it through would put an ungrounded
    # paragraph in front of someone who asked for a sourced one.
    if request.policy.require_citations and not resolvable:
        yield _event(
            {
                "type": "abstained",
                "reason": (
                    "the answer cited no passage that was supplied, so nothing in it "
                    "can be traced to a document"
                ),
            }
        )
        return

    yield _event(
        {
            "type": "done",
            "citedOrdinals": resolvable,
            # Whitespace-split words, and named as an estimate rather than
            # reported as a token count this service cannot know: the number of
            # tokens a model used is a property of its tokeniser.
            "outputTokens": len(answer.split()),
        }
    )


@router.post("/v1/generate")
async def generate(
    request: GenerateRequest,
    settings: Annotated[Settings, Depends(get_settings)],
) -> StreamingResponse:
    """Stream a grounded answer as server-sent events."""
    provider = _select_provider(request.policy, settings)

    return StreamingResponse(
        _stream(provider, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Streaming through nginx without this buffers the whole response
            # and delivers it at the end, which looks exactly like a hang.
            "X-Accel-Buffering": "no",
        },
    )
