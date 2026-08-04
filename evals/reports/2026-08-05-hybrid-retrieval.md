# Hybrid retrieval — 2026-08-05

First measurement through the real query path: the SQL the application issues,
inside the claims helper so row-level security applies exactly as it would for a
request. The previous baseline was a brute-force scan in Python.

**Corrected 2026-08-05 after review.** The first version of this report claimed
the query used the GIN and HNSW indexes. `EXPLAIN` shows otherwise, and the
truth is more interesting than the claim — see *Which plan you get* below.

**Corpus:** `gitlab-handbook-v1` seeded into a real workspace — 200 documents,
5,393 chunks, 22 scored questions.

## Results

| | recall@1 | recall@5 | recall@10 | complete@5 | complete@10 |
| --- | --- | --- | --- | --- | --- |
| **hybrid (FTS + vector, RRF)** | 0.32 | **0.82** | **0.86** | **0.50** | **0.59** |
| vector only | 0.27 | 0.73 | 0.77 | 0.41 | 0.50 |
| keyword only | 0.18 | 0.18 | 0.18 | 0.18 | 0.18 |

Measured with the HNSW plan (see below). Against the vector-only brute-force
baseline of recall@10 0.82 / complete@10 0.55, hybrid reaches **0.86 / 0.59**.

**recall@1 is not bolded, and "every measure improves" was withdrawn.** At k=1
hybrid scores 0.32 under the HNSW plan and 0.36 under the exact plan, against a
brute-force baseline of 0.27. The claim that every measure improves was made
from a single run and did not survive re-measurement. recall@5, recall@10 and
both completeness figures are stable across every plan and every reload; @1 is
not, and is reported as a range rather than a headline.

## Which plan you get, and why it matters

A tenant predicate defeats the HNSW index. `EXPLAIN` on the real query:

| rows in table | plan chosen | vector@5 | vector@10 | hybrid@1 |
| --- | --- | --- | --- | --- |
| 5,393 (one tenant) | `workspace_id` btree, exact sort | 0.77 | 0.82 | 0.36 |
| 10,786 (two tenants) | `document_chunks_embedding_idx` (HNSW) | 0.73 | 0.77 | 0.32 |

The exact figures match the Python brute-force baseline to the decimal, which is
what identifies the second row as approximation rather than a bug.

Three consequences, none of them cosmetic.

**Retrieval quality is not a property of the code alone.** The same query against
the same content returns different results depending on whether the planner
reaches for HNSW, and that decision moves with row count and statistics. It can
change under you between runs. The measurement now runs `ANALYZE` first and
prints which plan it got, because a number without its plan is not reproducible.

**The keyword arm does not use GIN.** It uses the `workspace_id` btree and then
filters on the tsvector. At 5,393 rows that is 8 ms and nobody notices; the cost
is linear in the tenant's chunk count, so it is a problem that arrives quietly.

**Hybrid is the robust one.** recall@5, recall@10 and both completeness figures
are identical under both plans. Fusion absorbs the approximation that moves
vector-only by five points — which is a better argument for hybrid retrieval
than the headline improvement is.

**The keyword arm is weak alone and still earns its place.** 0.18 flat across
every k, yet adding it lifts recall@5 from 0.73 to 0.82. It contributes the
exact identifiers, channel names and numbers an embedding smooths away.

## A measurement bug that made recall@1 meaningless

Fused results were tie-broken on `chunk_id` — a UUID minted at insert time.
Equal RRF scores are common, since every chunk found by a single search at a
given rank ties with every other such chunk, so at k=1 the winner was decided by
which UUIDs a particular load happened to generate. Three runs of the same corpus
produced 0.27, 0.32 and 0.36.

Ties now break on `(document title, chunk ordinal)`, which is derived from the
corpus and survives a reload. Fixing it also brought the exact-plan vector
figures into exact agreement with the brute-force baseline, which they had not
been before.

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
uv run python ../../evals/prepare_corpus.py gitlab-handbook-v1

cd ../..
pnpm --filter @clientatlas/product-api exec node scripts/load-corpus.mjs gitlab-handbook-v1
pnpm --filter @clientatlas/product-api run measure:retrieval
```

Chunking and embedding happen in Python; every tenant write happens in Node.
That split is the F1 boundary, not tidiness — an earlier version of the seeder
imported psycopg into the AI service, which broke the boundary and its own test.

The measurement runs in its own vitest config, deliberately. Five integration
suites call `truncateTenantTables()`, which truncates `organizations ... cascade`
and destroys any seeded corpus; when the measurement lived beside them it could
run against a table another suite had already emptied, where `hybrid >= vector`
is satisfied by `0 >= 0` and a cross-tenant assertion of `[]` passes because
there is nothing to leak. It now fails loudly on a missing or empty corpus, and
asserts the owner's own query returns rows *before* asserting a stranger's does
not.

The load uses the BYPASSRLS test credential and does not render documents to
PDF. Neither shortcut touches what retrieval reads.

## Not done

Generation, citation validation, abstention and SSE streaming. Retrieval returns
evidence; nothing yet turns it into an answer, so no claim about grounded
answers or abstention is supported by anything in the repository.

complete@10 of 0.59 is the number to keep in view. Four in ten questions still
do not have all their required evidence in the top ten, and no amount of prompt
engineering downstream can cite what retrieval did not return.
