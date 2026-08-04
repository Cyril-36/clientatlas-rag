# Hybrid retrieval — 2026-08-05

First measurement through the real query path: the SQL the application issues,
against the HNSW and GIN indexes it actually uses, inside the claims helper so
row-level security applies exactly as it would for a request. The previous
baseline was a brute-force scan in Python.

**Corpus:** `gitlab-handbook-v1` seeded into a real workspace — 200 documents,
5,393 chunks, 22 scored questions.

## Results

| | recall@1 | recall@5 | recall@10 | complete@5 | complete@10 |
| --- | --- | --- | --- | --- | --- |
| **hybrid (FTS + vector, RRF)** | **0.32** | **0.82** | **0.86** | **0.50** | **0.59** |
| vector only | 0.27 | 0.73 | 0.77 | 0.41 | 0.50 |
| keyword only | 0.18 | 0.18 | 0.18 | 0.18 | 0.18 |

Against the previous vector-only brute-force baseline (recall@10 0.82,
complete@10 0.55), hybrid reaches **0.86 / 0.59**. Every measure improves.

## Two things the numbers say that are easy to miss

**The index costs recall.** Vector-only through HNSW scores 0.77 at k=10 where
the exact brute-force scan scored 0.82. That is the approximation, not a
regression, and the earlier report predicted exactly this — an approximate index
does not return what a full scan does. It is the reason this measurement had to
be redone through the real path rather than trusted from Python.

**The keyword arm is weak alone and still earns its place.** 0.18 flat across
every k, yet adding it lifts recall@5 from 0.73 to 0.82. It contributes the
exact identifiers, channel names and numbers an embedding smooths away — the
four questions vectors missed outright were all of that kind.

## A rejected change, measured

0.18 flat across all k looks like a starved arm rather than a bad ranker, and it
is: `websearch_to_tsquery` joins terms with AND, so "How do I request production
access?" demands every content word in one chunk. It matches 23 chunks. The OR
form matches 1,811.

Widening the arm to OR made the hybrid clearly worse:

| | recall@5 | recall@10 | complete@10 |
| --- | --- | --- | --- |
| AND (kept) | **0.82** | **0.86** | **0.59** |
| OR (rejected) | 0.55 | 0.82 | 0.55 |

RRF scores by rank position alone, so twenty loosely-matching OR results arrive
carrying the same positional weight as twenty precise ones and push genuine
vector hits down. The keyword arm earns its place through precision, not
coverage, and widening it destroyed the property that made fusion work.

Reverted. The reasoning is recorded in `search.ts` so the next person to see a
0.18 arm and reach for the obvious fix has the measurement instead of the
intuition.

## Configuration

| | |
| --- | --- |
| Candidates per search | 20 |
| RRF constant `k` | 60 |
| Evidence chunks returned | 8 |

`k = 60` is from the original RRF paper and is large relative to 20 candidates
on purpose: it flattens the contribution curve so fusion rewards a chunk both
searches rank reasonably over one a single search ranks first. A unit test pins
that property rather than the constant.

## Reproducing

```bash
cd services/ai && uv sync --extra ml
uv run python ../../evals/seed_corpus.py gitlab-handbook-v1

cd ../.. && pnpm --filter @clientatlas/product-api exec \
  vitest run --config vitest.integration.config.ts tests/integration/retrieval.test.ts
```

The seed uses the BYPASSRLS test credential and does not render documents to
PDF — stated in `seed_corpus.py`, and neither shortcut touches what retrieval
reads. The chunker, the embedding model, the schema, the indexes and the query
path are all real.

The suite skips when the corpus has not been seeded, so it does not fail CI. One
assertion is a genuine gate: hybrid must not score below its own vector half. If
fusion ever destroys signal, that fails loudly.

## Not done

Generation, citation validation, abstention and SSE streaming. Retrieval returns
evidence; nothing yet turns it into an answer, so no claim about grounded
answers or abstention is supported by anything in the repository.

complete@10 of 0.59 is the number to keep in view. Four in ten questions still
do not have all their required evidence in the top ten, and no amount of prompt
engineering downstream can cite what retrieval did not return.
