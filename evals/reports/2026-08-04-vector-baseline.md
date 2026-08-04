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
| complete@1 | — | **0.18** |
| complete@5 | — | **0.45** |
| complete@10 | — | **0.55** |
| MRR@100 | — | **0.451** |

**`recall@k` and `complete@k` are different questions, and the gap between them
is the honest headline.** `recall@k` counts a question correct when *any*
expected passage reaches the top k — the standard retrieval measure, and what
the sweep compares on. `complete@k` requires *every* expected passage.

Eight of the 22 scored questions need evidence from more than one document, and
for those the two diverge sharply: recall@5 0.77 against complete@5 0.45. Nearly
half the questions that "pass" recall@5 are missing part of what they need.

That distinction matters more here than in a search product. A search result
that surfaces one of two relevant pages is useful. An answer that cites one of
the two documents a question requires is not half right — it is wrong, and wrong
in the way that reads most confident. An earlier version of this report leaned on
recall@5 while describing what the generator could cite; only complete@k supports
that reading.

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
| Embedding, 5,393 chunks | 20-32 s (170-280 chunks/s, CPU, M2, varies by run) |

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

Truncation explains the collapse at 650, but probably not the whole gap: nested
at target 240 has a median of 254 *estimated* tokens and still loses to flat,
0.68 against 0.73. That estimate is words x 1.3, not a tokenizer count, so a
median of 254 estimated sits near enough to the 256 limit that some of those
chunks are certainly being truncated — it cannot be called comfortably inside.
The honest statement is that truncation and topic-mixing are confounded here,
and separating them would need a run measured with the real tokenizer. The remaining difference is the
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

The committed configuration has the best measured recall@5 and recall@10. It does
not have the best recall@1: nested chunking reached 0.36 at target 120 and 0.41 at
target 240, against 0.27 here. An earlier draft of this section claimed recall@1
was invariant at 0.27, which contradicted the table directly above it.

That trade is worth stating rather than hiding. recall@1 moving while recall@5 and
recall@10 fall means nested chunking sometimes ranks a correct chunk first while
losing correct chunks from the set entirely — the merged chunks are larger, so a
hit covers more ground, but truncation drops whatever sits past 256 tokens.

The sweep compares on recall only, so it does not settle whether sibling merging
helps or hurts *evidence completeness*. It was rejected on recall@5 and recall@10,
which is a sufficient reason, but not the whole picture. Re-running the sweep with
complete@k would be the way to close that.

The next gain comes from hybrid retrieval — keyword search and RRF — rather than
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

# the table above
uv run python ../../evals/measure_baseline.py gitlab-handbook-v1

# the sibling-merge sweep in the correction
uv run python ../../evals/measure_baseline.py gitlab-handbook-v1 --sweep
```

Two earlier attempts at this section were wrong. The first cited
`pytest tests/test_eval_dataset.py`, which is hardcoded to `onboarding-v1` and
prints 21 chunks rather than 5,393. The second tracked a sweep script that could
not reproduce its own table: the sibling-merge logic the "nested" rows depend on
had been reverted from the chunker, so those four rows came out byte-identical to
the flat ones.

The rejected variant now lives inside `measure_baseline.py`, and only there — a
table that justifies rejecting a design is worthless if nobody can re-run it, and
production code should not carry an implementation that measurement has already
rejected. All eight rows reproduce.

The figures come from a brute-force scan over every chunk, which is only
tractable at this corpus size. Once retrieval exists this becomes an HNSW query
and the numbers must be regenerated through it, since an approximate index does
not return exactly what a full scan does.
