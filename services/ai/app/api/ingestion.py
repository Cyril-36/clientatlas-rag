"""Parsing and embedding endpoints.

Implements the parse and embed halves of the contract in
`packages/contracts/src/ai-service.ts`. Nothing here takes a tenant identifier,
because nothing here needs one: the caller has already decided what this text
is and who it belongs to.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.embedding.provider import (
    DeterministicProvider,
    EmbeddingProvider,
    EmbeddingUnavailableError,
    MiniLMProvider,
)
from app.ingestion.chunking import Chunk, chunk_blocks
from app.ingestion.parsing import ParseError, parse_document

router = APIRouter(tags=["ingestion"])

SettingsDep = Annotated[Settings, Depends(get_settings)]

MAX_EMBED_BATCH = 64


@lru_cache(maxsize=2)
def _provider_for(name: str) -> EmbeddingProvider:
    """One provider instance per process, so the model loads at most once."""
    if name == "deterministic":
        return DeterministicProvider()

    return MiniLMProvider()


class ParseRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    media_type: str = Field(alias="mediaType")
    content_base64: str = Field(alias="contentBase64", min_length=1)

    model_config = {"populate_by_name": True}


class ParsedBlockModel(BaseModel):
    ordinal: int
    text: str
    page_number: int | None = Field(serialization_alias="pageNumber")
    heading_path: list[str] = Field(serialization_alias="headingPath")


class ChunkModel(BaseModel):
    ordinal: int
    text: str
    page_number: int | None = Field(serialization_alias="pageNumber")
    heading_path: list[str] = Field(serialization_alias="headingPath")
    token_count: int = Field(serialization_alias="tokenCount")


class ParseResponse(BaseModel):
    blocks: list[ParsedBlockModel]
    chunks: list[ChunkModel]
    page_count: int = Field(serialization_alias="pageCount")
    checksum_sha256: str = Field(serialization_alias="checksumSha256")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_EMBED_BATCH)


class EmbedResponse(BaseModel):
    model: str
    dimensions: int
    vectors: list[list[float]]


def _to_chunk_model(chunk: Chunk) -> ChunkModel:
    return ChunkModel(
        ordinal=chunk.ordinal,
        text=chunk.text,
        page_number=chunk.page_number,
        heading_path=list(chunk.heading_path),
        token_count=chunk.token_count,
    )


@router.post("/v1/parse", response_model=ParseResponse, response_model_by_alias=True)
def parse(request: ParseRequest) -> ParseResponse:
    """Parse a document and return both its blocks and its chunks.

    Chunking happens here rather than in the caller because it depends on the
    heading structure the parser just recovered. Splitting the two across a
    network boundary would mean serialising that structure twice.
    """
    try:
        data = base64.b64decode(request.content_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail={"code": "FILE_UNREADABLE"}) from error

    try:
        result = parse_document(data, request.media_type)
    except ParseError as error:
        # Only the code travels. Parser messages can quote the document.
        raise HTTPException(status_code=422, detail={"code": error.code}) from error

    chunks = chunk_blocks(result.blocks)

    return ParseResponse(
        blocks=[
            ParsedBlockModel(
                ordinal=block.ordinal,
                text=block.text,
                page_number=block.page_number,
                heading_path=list(block.heading_path),
            )
            for block in result.blocks
        ],
        chunks=[_to_chunk_model(chunk) for chunk in chunks],
        page_count=result.page_count,
        checksum_sha256=hashlib.sha256(data).hexdigest(),
    )


@router.post("/v1/embed", response_model=EmbedResponse)
def embed(request: EmbedRequest, settings: SettingsDep) -> EmbedResponse:
    """Embed a batch of texts."""
    provider = _provider_for(settings.embedding_provider)

    try:
        vectors = provider.embed(request.texts)
    except EmbeddingUnavailableError as error:
        # 503 rather than 500: the service is fine, its optional model is not
        # installed, and retrying without changing anything will not help.
        raise HTTPException(
            status_code=503,
            detail={"code": "EMBEDDING_MODEL_UNAVAILABLE", "message": str(error)},
        ) from error

    return EmbedResponse(
        # Reports what actually ran. The Node contract pins this to the real
        # model name, so deterministic vectors are refused by the caller rather
        # than quietly written to the database.
        model=provider.model_name,
        dimensions=provider.dimensions,
        vectors=vectors,
    )
