#!/usr/bin/env python3
"""Prepare an evaluation corpus for loading: chunk it and embed it.

    cd services/ai
    uv run python ../../evals/prepare_corpus.py gitlab-handbook-v1
    cd ../.. && pnpm --filter @clientatlas/product-api exec \
        node scripts/load-corpus.mjs gitlab-handbook-v1

Chunks with the real chunker and embeds with the real MiniLM, then writes the
result to JSON. It does **not** touch the database.

That split is not tidiness. The AI service holds no tenant database access by
design, and `tests/test_boundary.py` fails the build if a database driver is
added to it. An earlier version of this script imported psycopg and wrote rows
directly, which broke that boundary and its own test — the test was simply not
re-run before the work was reported as passing. Loading is now `load_corpus.mjs`,
in Node, where every other tenant-scoped write already lives.

One shortcut, stated rather than hidden: documents are not rendered to PDF and
re-parsed. The parser has its own tests, and the chunker is fed the same blocks
either way, so this cannot change what retrieval sees.

What is real: the chunker, the embedding model, and — once loaded — the schema,
the indexes and the query path.

Query vectors are written alongside, so measurement needs neither the AI service
nor the model.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services" / "ai"))

from app.embedding.provider import MiniLMProvider  # noqa: E402
from app.ingestion.chunking import chunk_blocks  # noqa: E402
from app.ingestion.parsing import ParsedBlock  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    dataset = sys.argv[1]
    base = REPO / "evals" / "datasets" / dataset
    corpus: dict[str, Any] = json.loads((base / "corpus.json").read_text(encoding="utf-8"))
    questions: dict[str, Any] = json.loads((base / "questions.json").read_text(encoding="utf-8"))

    provider = MiniLMProvider()
    started = time.time()

    documents: list[dict[str, Any]] = []
    texts: list[str] = []

    for document in corpus["documents"]:
        blocks: list[ParsedBlock] = []
        ordinal = 0
        for section in document["sections"]:
            for paragraph in section["paragraphs"]:
                ordinal += 1
                blocks.append(
                    ParsedBlock(
                        ordinal=ordinal,
                        text=paragraph,
                        page_number=1,
                        heading_path=(section["heading"],),
                    )
                )

        chunks = [
            {
                "ordinal": chunk.ordinal,
                "text": chunk.text,
                "pageNumber": chunk.page_number,
                "headingPath": list(chunk.heading_path),
                "tokenCount": chunk.token_count,
            }
            for chunk in chunk_blocks(blocks)
        ]
        texts.extend(chunk["text"] for chunk in chunks)

        documents.append(
            {
                "slug": document["slug"],
                "mediaType": document.get("mediaType", "application/pdf"),
                "chunks": chunks,
            }
        )

    total = sum(len(d["chunks"]) for d in documents)
    print(f"chunked {total} chunks from {len(documents)} documents")

    vectors: list[list[float]] = []
    for offset in range(0, len(texts), 64):
        vectors.extend(provider.embed(texts[offset : offset + 64]))

    cursor = 0
    for document in documents:
        for chunk in document["chunks"]:
            chunk["embedding"] = vectors[cursor]
            cursor += 1

    scored = [
        q
        for q in questions["questions"]
        if q["answerable"] and q["expected"] and not q.get("askAsNonMember")
    ]
    query_vectors = provider.embed([q["question"] for q in scored])

    print(f"embedded in {time.time() - started:.1f}s")

    out = REPO / "evals" / "reports" / f"{dataset}-prepared.json"
    out.write_text(
        json.dumps(
            {
                "dataset": dataset,
                "chunks": total,
                "documents": documents,
                "questions": [
                    {
                        "id": q["id"],
                        "question": q["question"],
                        "category": q["category"],
                        "expected": q["expected"],
                        "embedding": vector,
                    }
                    for q, vector in zip(scored, query_vectors, strict=True)
                ],
            }
        ),
        encoding="utf-8",
    )

    print(f"wrote {out.relative_to(REPO)}  ({total} chunks)")
    print(
        "now load it:  pnpm --filter @clientatlas/product-api exec "
        "node scripts/load-corpus.mjs " + dataset
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
