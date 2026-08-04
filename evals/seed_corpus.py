#!/usr/bin/env python3
"""Load an evaluation corpus into a real workspace.

    cd services/ai
    uv run python ../../evals/seed_corpus.py gitlab-handbook-v1

Chunks with the real chunker, embeds with the real MiniLM, and writes documents,
versions and chunks straight into PostgreSQL so retrieval can be measured
through the actual SQL and the actual HNSW index rather than a brute-force scan
in Python.

Two shortcuts, both deliberate and both stated rather than hidden:

* Rows are inserted with the BYPASSRLS test credential. Seeding is not the
  thing under test, and driving 5,000 chunks through the upload API would
  measure the upload API.
* Documents are not rendered to PDF and re-parsed. The parser has its own tests;
  re-running it here would only slow the seed and could not change what
  retrieval sees, since the chunker is fed the same blocks either way.

What *is* real: the chunker, the embedding model, the schema, the indexes, and
the query path that reads them back.

Writes query vectors alongside, so the measurement step does not need the AI
service running.
"""

# ruff: noqa: T201

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services" / "ai"))

import psycopg  # noqa: E402

from app.embedding.provider import MiniLMProvider  # noqa: E402
from app.ingestion.chunking import chunk_blocks  # noqa: E402
from app.ingestion.parsing import ParsedBlock  # noqa: E402


def load_env() -> None:
    env = REPO / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    dataset = sys.argv[1]
    load_env()

    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        print("TEST_DATABASE_URL is not set")
        return 2

    base = REPO / "evals" / "datasets" / dataset
    corpus: dict[str, Any] = json.loads((base / "corpus.json").read_text(encoding="utf-8"))
    questions: dict[str, Any] = json.loads((base / "questions.json").read_text(encoding="utf-8"))

    user_id, org_id, workspace_id = (str(uuid.uuid4()) for _ in range(3))

    provider = MiniLMProvider()

    with psycopg.connect(url, autocommit=False) as conn, conn.cursor() as cur:
        # A dedicated tenant per seed run, so repeated runs cannot accumulate
        # into each other and quietly change the corpus being measured.
        cur.execute(
            "insert into profiles (id, email, display_name) values (%s, %s, %s)",
            (user_id, f"eval-{user_id[:8]}@example.test", "eval"),
        )
        cur.execute(
            "insert into organizations (id, name, slug) values (%s, %s, %s)",
            (org_id, f"eval {dataset}", f"eval-{org_id[:8]}"),
        )
        cur.execute(
            "insert into organization_members (organization_id, user_id, role) "
            "values (%s, %s, 'owner')",
            (org_id, user_id),
        )
        cur.execute(
            "insert into workspaces (id, organization_id, name, slug) values (%s, %s, %s, %s)",
            (workspace_id, org_id, dataset, "eval"),
        )

        started = time.time()
        total_chunks = 0
        pending: list[tuple[str, int, str]] = []  # (document_id, ordinal, text)
        metadata: list[tuple[Any, ...]] = []

        for document in corpus["documents"]:
            document_id, version_id = str(uuid.uuid4()), str(uuid.uuid4())

            cur.execute(
                "insert into documents (id, organization_id, workspace_id, title, "
                "original_filename, media_type, status) values (%s,%s,%s,%s,%s,%s,'ready')",
                (
                    document_id,
                    org_id,
                    workspace_id,
                    document["slug"],
                    f"{document['slug']}.pdf",
                    document.get("mediaType", "application/pdf"),
                ),
            )
            cur.execute(
                "insert into document_versions (id, organization_id, document_id, "
                "version_number, storage_path, byte_size, checksum_sha256) "
                "values (%s,%s,%s,1,%s,%s,%s)",
                (
                    version_id,
                    org_id,
                    document_id,
                    f"organizations/{org_id}/workspaces/{workspace_id}/documents/"
                    f"{document_id}/{version_id}.pdf",
                    1,
                    "0" * 64,
                ),
            )

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

            for chunk in chunk_blocks(blocks):
                pending.append((document_id, chunk.ordinal, chunk.text))
                metadata.append(
                    (
                        org_id,
                        workspace_id,
                        document_id,
                        version_id,
                        chunk.ordinal,
                        chunk.text,
                        chunk.page_number,
                        list(chunk.heading_path),
                        chunk.token_count,
                    )
                )
                total_chunks += 1

        print(f"chunked {total_chunks} chunks from {len(corpus['documents'])} documents")

        vectors: list[list[float]] = []
        for offset in range(0, len(pending), 64):
            vectors.extend(provider.embed([text for _, _, text in pending[offset : offset + 64]]))
        print(f"embedded in {time.time() - started:.1f}s")

        for row, vector in zip(metadata, vectors, strict=True):
            cur.execute(
                "insert into document_chunks (organization_id, workspace_id, document_id, "
                "document_version_id, ordinal, content, page_number, heading_path, "
                "token_count, embedding) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)",
                (*row, json.dumps(vector)),
            )

        conn.commit()

    scored = [
        q
        for q in questions["questions"]
        if q["answerable"] and q["expected"] and not q.get("askAsNonMember")
    ]
    query_vectors = provider.embed([q["question"] for q in scored])

    out = REPO / "evals" / "reports" / f"{dataset}-seed.json"
    out.write_text(
        json.dumps(
            {
                "dataset": dataset,
                "userId": user_id,
                "organizationId": org_id,
                "workspaceId": workspace_id,
                "chunks": total_chunks,
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

    print(f"workspace {workspace_id}  ({total_chunks} chunks)")
    print(f"wrote {out.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
