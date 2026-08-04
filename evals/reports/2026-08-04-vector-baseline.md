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

## CORRECTION, same day — the "defect" below was a misdiagnosis

The section that follows is left unedited because it is what the next change was
based on, and deleting it would hide why that change was attempted. **Do not act
on it.** It is wrong, and a measured sweep shows why.

`all-MiniLM-L6-v2` has a **256-token sequence window**. Anything past it is
silently discarded before the model sees the text — a 500-word chunk loses 49%
of itself. So `DEFAULT_TARGET_TOKENS = 650` is not a target the system should
ever hit. It is a ceiling that heading boundaries reach first, and the median of
116 was the chunker landing near the encoder's usable range, not failing to
reach a goal.

Sibling merging was implemented and measured. Recall got worse at every setting:

| heading paths | target | chunks | median tokens | recall@1 | recall@5 | recall@10 |
| ------------- | ------ | ------ | ------------- | -------- | -------- | --------- |
| flat (current) | 120 | 10,397 | 105 | 0.27 | 0.55 | 0.73 |
| flat (current) | 180 | 8,091 | 124 | 0.27 | 0.68 | 0.77 |
| flat (current) | 240 | 6,950 | 126 | 0.27 | 0.73 | 0.82 |
| **flat (current)** | **650** | **5,393** | **116** | **0.27** | **0.77** | **0.82** |
| nested + sibling merge | 120 | 9,463 | 131 | 0.36 | 0.55 | 0.68 |
| nested + sibling merge | 180 | 6,322 | 195 | 0.23 | 0.64 | 0.77 |
| nested + sibling merge | 240 | 4,726 | 254 | 0.41 | 0.68 | 0.73 |
| nested + sibling merge | 650 | 1,594 | 670 | 0.14 | **0.50** | 0.68 |

**The committed configuration is the best of everything tested.** Nothing in the
sweep beats recall@5 0.77.

Truncation explains the collapse at 650, but not the whole gap: nested at
target 240 has a median of 254 estimated tokens, comfortably inside the window,
and still loses to flat at 0.68 against 0.73. The remaining difference is the
thing the heading rule was protecting in the first place — merging sibling
sections mixes topics, and a chunk covering two subjects retrieves for queries
about either and answers neither.

The change was reverted. Two things are worth keeping from the attempt:

- **The 256-token window is the real constraint**, and it was missing from this
  report. Any future chunking work is bounded by it.
- The measurement harness was changed in the same step as the chunker, which
  made the before/after incomparable, and it collapsed the authored corpus from
  21 chunks to 7 — where top-5 is 71% of everything and the printed 0.92 means
  nothing. **Change one variable at a time, and re-run the baseline before
  believing a number.**

recall@1 of 0.27 is stubborn across every configuration. That is the signal that
the next gain comes from hybrid retrieval — keyword search and RRF — rather than
from more chunking work.

---

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
