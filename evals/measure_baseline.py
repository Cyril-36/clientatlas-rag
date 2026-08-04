#!/usr/bin/env python3
"""Measure vector-only retrieval over an evaluation dataset.

    cd services/ai
    uv run python ../../evals/measure_baseline.py gitlab-handbook-v1
    uv run python ../../evals/measure_baseline.py gitlab-handbook-v1 --sweep

Reproduces the figures in `evals/reports/`. This exists as tracked code because
the first version of that report cited a command that ran a different dataset
entirely — it pointed at the pytest baseline, which is hardcoded to
`onboarding-v1` and prints 21 chunks, not the 5,393 the report claimed. A
number nobody else can regenerate is not a measurement.

Requires the ML extra: `uv sync --extra ml`.

`--sweep` re-chunks and re-embeds at several targets, with and without nesting
each section under its document title. Nesting is what lets the chunker's
sibling-merge rule fire; without it every heading path is one deep and the rule
never applies. The sweep is how the sibling-merge proposal was rejected.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services" / "ai"))

import json  # noqa: E402

from app.embedding.provider import MiniLMProvider  # noqa: E402
from app.ingestion.chunking import chunk_blocks  # noqa: E402
from app.ingestion.parsing import ParsedBlock  # noqa: E402

Chunk = tuple[str, str, int]


def load(dataset: str, name: str) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(
        (REPO / "evals" / "datasets" / dataset / name).read_text(encoding="utf-8")
    )
    return parsed


def build_chunks(corpus: dict[str, Any], *, nested: bool, target: int, maximum: int) -> list[Chunk]:
    out: list[Chunk] = []

    for document in corpus["documents"]:
        blocks: list[ParsedBlock] = []
        ordinal = 0

        for section in document["sections"]:
            path = (document["title"], section["heading"]) if nested else (section["heading"],)
            for paragraph in section["paragraphs"]:
                ordinal += 1
                blocks.append(
                    ParsedBlock(
                        ordinal=ordinal, text=paragraph, page_number=1, heading_path=path
                    )
                )

        for chunk in chunk_blocks(
            blocks,
            target_tokens=target,
            max_tokens=maximum,
            overlap_tokens=min(100, target // 4),
        ):
            out.append((document["slug"], chunk.text, chunk.token_count))

    return out


def scored_questions(dataset: str) -> list[dict[str, Any]]:
    return [
        question
        for question in load(dataset, "questions.json")["questions"]
        if question["answerable"]
        and question["expected"]
        and not question.get("askAsNonMember")
    ]


def evaluate(
    chunks: list[Chunk],
    chunk_vectors: list[list[float]],
    questions: list[dict[str, Any]],
    question_vectors: list[list[float]],
    ks: tuple[int, ...],
) -> tuple[dict[int, float], float, list[str]]:
    recalls: dict[int, int] = dict.fromkeys(ks, 0)
    reciprocal: list[float] = []
    missed: list[str] = []

    for question, query in zip(questions, question_vectors, strict=True):
        ranked = sorted(
            (
                (sum(a * b for a, b in zip(query, vector, strict=True)), index)
                for index, vector in enumerate(chunk_vectors)
            ),
            reverse=True,
        )

        def matches(index: int, question: dict[str, Any] = question) -> bool:
            slug, text, _ = chunks[index]
            return any(
                slug == expectation["document"] and expectation["mustContain"] in text
                for expectation in question["expected"]
            )

        for k in ks:
            if any(matches(index) for _, index in ranked[:k]):
                recalls[k] += 1

        rank = next((r for r, (_, i) in enumerate(ranked[:100], 1) if matches(i)), None)
        reciprocal.append(1 / rank if rank else 0.0)

        if not any(matches(index) for _, index in ranked[: max(ks)]):
            missed.append(question["id"])

    total = len(questions)
    return ({k: recalls[k] / total for k in ks}, sum(reciprocal) / total, missed)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset")
    parser.add_argument("--sweep", action="store_true", help="compare chunking configurations")
    args = parser.parse_args()

    corpus = load(args.dataset, "corpus.json")
    questions = scored_questions(args.dataset)
    provider = MiniLMProvider()
    query_vectors = provider.embed([question["question"] for question in questions])

    def embed(chunks: list[Chunk]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for offset in range(0, len(chunks), 64):
            vectors.extend(provider.embed([text for _, text, _ in chunks[offset : offset + 64]]))
        return vectors

    if args.sweep:
        print(f"{'config':<32}{'chunks':>8}{'med tok':>9}{'r@1':>7}{'r@5':>7}{'r@10':>7}")
        print("-" * 70)

        for nested in (False, True):
            for target, maximum in ((120, 160), (180, 240), (240, 300), (650, 800)):
                chunks = build_chunks(corpus, nested=nested, target=target, maximum=maximum)
                recalls, _, _ = evaluate(
                    chunks, embed(chunks), questions, query_vectors, (1, 5, 10)
                )
                median = statistics.median(tokens for _, _, tokens in chunks)
                label = f"{'nested' if nested else 'flat  '} target={target}"
                print(
                    f"{label:<32}{len(chunks):>8}{median:>9.0f}"
                    f"{recalls[1]:>7.2f}{recalls[5]:>7.2f}{recalls[10]:>7.2f}"
                )

        return 0

    started = time.time()
    chunks = build_chunks(corpus, nested=False, target=650, maximum=800)
    chunking_seconds = time.time() - started

    tokens = sorted(count for _, _, count in chunks)
    paragraphs = sum(
        len(section["paragraphs"])
        for document in corpus["documents"]
        for section in document["sections"]
    )

    started = time.time()
    chunk_vectors = embed(chunks)
    embedding_seconds = time.time() - started

    recalls, mrr, missed = evaluate(chunks, chunk_vectors, questions, query_vectors, (1, 5, 10))

    print(f"dataset:     {args.dataset}")
    print(f"documents:   {len(corpus['documents'])}")
    print(f"paragraphs:  {paragraphs}")
    print(f"chunks:      {len(chunks)}")
    print(f"questions:   {len(questions)} scored")
    print()
    print(
        f"tokens/chunk min {tokens[0]}  median {tokens[len(tokens) // 2]}  "
        f"p90 {tokens[int(len(tokens) * 0.9)]}  max {tokens[-1]}"
    )
    print(f"chunking:    {chunking_seconds:.1f}s")
    print(
        f"embedding:   {embedding_seconds:.1f}s "
        f"({len(chunks) / max(embedding_seconds, 1e-9):.0f} chunks/s)"
    )
    print()
    for k in (1, 5, 10):
        print(f"recall@{k:<3} {recalls[k]:.2f}")
    print(f"MRR@100    {mrr:.3f}")
    if missed:
        print(f"\nnot in top 10: {', '.join(missed)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
