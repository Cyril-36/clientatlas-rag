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

# This is a reporting CLI; printing numbers for a human is the whole job.
# ruff: noqa: T201

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
from app.ingestion.chunking import Chunk, chunk_blocks, estimate_tokens  # noqa: E402
from app.ingestion.parsing import ParsedBlock  # noqa: E402

ScoredChunk = tuple[str, str, int]


# ---------------------------------------------------------------------------
# The rejected sibling-merge chunker.
#
# This lived in app/ingestion/chunking.py briefly and was reverted after the
# sweep below showed it loses at every setting. It is reproduced here, and only
# here, because a table that justifies rejecting a design is worthless if nobody
# can re-run it — and the first version of this script could not: with the merge
# logic gone, nesting heading paths does nothing and the "nested" rows came out
# byte-identical to the flat ones.
#
# It is deliberately not importable from the application. Production code should
# not carry a variant that measurement has already rejected.
# ---------------------------------------------------------------------------


def _same_or_sibling(previous: tuple[str, ...], current: tuple[str, ...]) -> bool:
    if previous == current:
        return True
    # Direct siblings share a non-empty parent.
    return len(previous) > 1 and len(previous) == len(current) and previous[:-1] == current[:-1]


def _common_heading_path(buffer: list[ParsedBlock]) -> tuple[str, ...]:
    common = list(buffer[0].heading_path)
    for block in buffer[1:]:
        while common and tuple(common) != block.heading_path[: len(common)]:
            common.pop()
    return tuple(common)


def _overlap(buffer: list[ParsedBlock], overlap_tokens: int) -> list[ParsedBlock]:
    carried: list[ParsedBlock] = []
    total = 0
    for block in reversed(buffer):
        tokens = estimate_tokens(block.text)
        if total + tokens > overlap_tokens and carried:
            break
        carried.insert(0, block)
        total += tokens
    if len(carried) >= len(buffer):
        carried = carried[1:]
    return carried


def chunk_blocks_sibling_merge(
    blocks: list[ParsedBlock],
    target_tokens: int,
    max_tokens: int,
    overlap_tokens: int,
) -> list[Chunk]:
    """The reverted variant: short sibling sections may share a chunk."""
    chunks: list[Chunk] = []
    buffer: list[ParsedBlock] = []
    buffer_tokens = 0
    previous: tuple[str, ...] | None = None
    ordinal = 0

    def flush() -> None:
        nonlocal buffer, buffer_tokens, ordinal
        if not buffer:
            return
        ordinal += 1
        text = "\n".join(block.text for block in buffer)
        chunks.append(
            Chunk(
                ordinal=ordinal,
                text=text,
                page_number=next((b.page_number for b in buffer if b.page_number), None),
                heading_path=_common_heading_path(buffer),
                token_count=estimate_tokens(text),
            )
        )
        buffer = list(_overlap(buffer, overlap_tokens))
        buffer_tokens = sum(estimate_tokens(block.text) for block in buffer)

    for block in blocks:
        if previous is not None and not _same_or_sibling(previous, block.heading_path):
            flush()
            buffer = []
            buffer_tokens = 0
        previous = block.heading_path

        tokens = estimate_tokens(block.text)
        if buffer and buffer_tokens + tokens > max_tokens:
            flush()
        buffer.append(block)
        buffer_tokens += tokens
        if buffer_tokens >= target_tokens:
            flush()

    flush()
    return chunks


def load(dataset: str, name: str) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(
        (REPO / "evals" / "datasets" / dataset / name).read_text(encoding="utf-8")
    )
    return parsed


def build_chunks(
    corpus: dict[str, Any], *, nested: bool, target: int, maximum: int, sibling_merge: bool = False
) -> list[ScoredChunk]:
    out: list[ScoredChunk] = []

    for document in corpus["documents"]:
        blocks: list[ParsedBlock] = []
        ordinal = 0

        for section in document["sections"]:
            path = (document["title"], section["heading"]) if nested else (section["heading"],)
            for paragraph in section["paragraphs"]:
                ordinal += 1
                blocks.append(
                    ParsedBlock(ordinal=ordinal, text=paragraph, page_number=1, heading_path=path)
                )

        overlap = min(100, target // 4)
        produced = (
            chunk_blocks_sibling_merge(blocks, target, maximum, overlap)
            if sibling_merge
            else chunk_blocks(
                blocks, target_tokens=target, max_tokens=maximum, overlap_tokens=overlap
            )
        )

        for chunk in produced:
            out.append((document["slug"], chunk.text, chunk.token_count))

    return out


def scored_questions(dataset: str) -> list[dict[str, Any]]:
    return [
        question
        for question in load(dataset, "questions.json")["questions"]
        if question["answerable"] and question["expected"] and not question.get("askAsNonMember")
    ]


def evaluate(
    chunks: list[ScoredChunk],
    chunk_vectors: list[list[float]],
    questions: list[dict[str, Any]],
    question_vectors: list[list[float]],
    ks: tuple[int, ...],
) -> tuple[dict[int, float], dict[int, float], float, list[str]]:
    """Returns (recall@k, complete@k, MRR, ids missed at max k).

    Two different questions, deliberately reported separately.

    `recall@k` counts a question correct when **any** expected passage appears in
    the top k. That is the standard retrieval measure and the one the sweep
    compares on.

    `complete@k` counts it correct only when **every** expected passage appears.
    For the five multi-document questions these differ, and the difference is the
    one that matters for a RAG system: an answer that cites one of the two
    documents a question needs is not half right, it is wrong in a way that reads
    as confident. Reporting only recall would overstate what the evidence set can
    support.
    """
    recalls: dict[int, int] = dict.fromkeys(ks, 0)
    complete: dict[int, int] = dict.fromkeys(ks, 0)
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

        def found_all(indices: list[int], question: dict[str, Any] = question) -> bool:
            texts = [(chunks[i][0], chunks[i][1]) for i in indices]
            return all(
                any(
                    slug == expectation["document"] and expectation["mustContain"] in text
                    for slug, text in texts
                )
                for expectation in question["expected"]
            )

        for k in ks:
            top_indices = [index for _, index in ranked[:k]]
            if any(matches(index) for index in top_indices):
                recalls[k] += 1
            if found_all(top_indices):
                complete[k] += 1

        rank = next((r for r, (_, i) in enumerate(ranked[:100], 1) if matches(i)), None)
        reciprocal.append(1 / rank if rank else 0.0)

        if not any(matches(index) for _, index in ranked[: max(ks)]):
            missed.append(question["id"])

    total = len(questions)
    return (
        {k: recalls[k] / total for k in ks},
        {k: complete[k] / total for k in ks},
        sum(reciprocal) / total,
        missed,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset")
    parser.add_argument("--sweep", action="store_true", help="compare chunking configurations")
    args = parser.parse_args()

    corpus = load(args.dataset, "corpus.json")
    questions = scored_questions(args.dataset)
    provider = MiniLMProvider()
    query_vectors = provider.embed([question["question"] for question in questions])

    def embed(chunks: list[ScoredChunk]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for offset in range(0, len(chunks), 64):
            vectors.extend(provider.embed([text for _, text, _ in chunks[offset : offset + 64]]))
        return vectors

    if args.sweep:
        print(f"{'config':<32}{'chunks':>8}{'med tok':>9}{'r@1':>7}{'r@5':>7}{'r@10':>7}")
        print("-" * 70)

        for nested in (False, True):
            for target, maximum in ((120, 160), (180, 240), (240, 300), (650, 800)):
                chunks = build_chunks(
                    corpus,
                    nested=nested,
                    target=target,
                    maximum=maximum,
                    sibling_merge=nested,
                )
                recalls, _, _, _ = evaluate(
                    chunks, embed(chunks), questions, query_vectors, (1, 5, 10)
                )
                median = statistics.median(tokens for _, _, tokens in chunks)
                label = f"{'nested+merge' if nested else 'flat        '} target={target}"
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

    recalls, complete, mrr, missed = evaluate(
        chunks, chunk_vectors, questions, query_vectors, (1, 5, 10)
    )

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
    multi = sum(1 for q in questions if len({e["document"] for e in q["expected"]}) > 1)

    print(f"{'k':<5}{'recall@k':>10}{'complete@k':>12}")
    for k in (1, 5, 10):
        print(f"{k:<5}{recalls[k]:>10.2f}{complete[k]:>12.2f}")
    print(f"\nMRR@100    {mrr:.3f}")
    print(
        f"\nrecall@k counts a question correct when ANY expected passage is in the top k;\n"
        f"complete@k requires ALL of them. They differ for the {multi} questions whose\n"
        f"evidence spans more than one document."
    )
    if missed:
        print(f"\nnot in top 10: {', '.join(missed)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
