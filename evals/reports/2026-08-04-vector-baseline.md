# Vector-only baseline — 2026-08-04

Measured before hybrid retrieval exists, so there is a fixed number to improve
on rather than a number chosen after the fact.

**Setup:** `all-MiniLM-L6-v2`, cosine over normalised vectors, brute-force
scan. No keyword search, no RRF, no reranking. Chunking is the current
heading-bounded chunker at its defaults (target 650, max 800, overlap 100).

## Corpora

| | `onboarding-v1` | `gitlab-handbook-v1` |
| --- | --- | --- |
| Source | authored | GitLab Handbook, CC BY-SA 4.0 |
| Documents | 7 | 200 |
| Paragraphs | 37 | 18,640 |
| Chunks | 21 | 5,393 |
| Scored questions | 13 | 22 |

## Results

| Metric | `onboarding-v1` | `gitlab-handbook-v1` |
| --- | --- | --- |
| recall@1 | 0.92 | **0.27** |
| recall@5 | 1.00 | **0.77** |
| recall@10 | — | **0.82** |
| MRR@100 | — | **0.451** |

The authored corpus is too small for its numbers to mean anything — top-5 covers
almost a quarter of every chunk in it, so recall@5 reads 1.00 regardless of what
retrieval does. It is kept for the hazard categories (prompt injection,
contradiction, abstention), which cannot be sourced from a real corpus, and its
retrieval numbers should not be quoted.

The GitLab numbers are the real baseline. recall@1 of 0.27 is what embeddings
alone achieve on a realistic corpus, and is exactly the gap hybrid retrieval is
supposed to close.

Not found in the top 10 by vectors alone: **g08, g09, g25, g27**. Worth reading
before tuning — if keyword search does not rescue them, the questions or the
chunking are the problem, not the ranker.

## Throughput

| | |
| --- | --- |
| Chunking, 18,640 paragraphs | 0.1 s |
| Embedding, 5,393 chunks | 32.4 s (166 chunks/s, CPU, M2) |

Embedding dominates ingestion, as expected. At this rate a 200-page corpus
indexes in about half a minute, which is comfortably inside what a background
worker can absorb.

## The defect this surfaced

Chunk sizes are far below target:

| | tokens |
| --- | --- |
| min | 1 |
| median | **116** |
| p90 | 370 |
| max | 967 |

The target is 650. A median of 116 means most chunks carry a fraction of the
context they were designed to, and a one-token chunk is pure noise in the index.

The cause is the rule that a chunk never spans a heading boundary. That rule is
right — mixing sections retrieves for queries about either and answers neither —
but the GitLab handbook has many short sections, so the chunker flushes almost
immediately and the target is never reached. The authored corpus never showed
this because its sections are uniform.

`max` exceeding the 800 ceiling is separate and expected: a single paragraph
longer than the limit cannot be split by a chunker that only groups whole
blocks.

Two fixes worth trying, in this order, measured against this baseline:

1. Allow a chunk to span *sibling* sections under the same parent heading, while
   still refusing to cross a top-level boundary. Keeps the property that matters
   and lets short sections combine.
2. Split oversized paragraphs on sentence boundaries so `max` respects the
   ceiling.

Neither should be attempted without re-running this baseline afterwards.

## Reproducing

```bash
cd services/ai && uv sync --extra ml
uv run pytest tests/test_eval_dataset.py -q
```

The per-corpus figures above come from a brute-force scan over every chunk,
which is only tractable because the corpus is small. Once retrieval exists this
becomes an HNSW query and the numbers should be regenerated through it, since an
approximate index does not return exactly what a full scan does.
