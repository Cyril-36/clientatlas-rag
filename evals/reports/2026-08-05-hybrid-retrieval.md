# Hybrid retrieval — 2026-08-05

First measurement through the real query path: the SQL the application issues,
inside the claims helper so row-level security applies exactly as it would for a
request. The previous baseline was a brute-force scan in Python.

**Corrected twice on 2026-08-05, both times after review.** The first version
asserted that the query used the GIN and HNSW indexes. The second, correcting
it, asserted that it used neither and tied each plan to a row count. Both were
generalisations from a single `EXPLAIN`, and both are wrong in the same way: the
planner's choice moves under an unchanged corpus, and has since been observed
resolving every way described. What replaced the assertions is machinery — the
plan is recorded from inside the transaction being measured, and the cost of the
approximate plan is measured by forcing the exact one. See *Which plan you get*.

**Corpus:** `gitlab-handbook-v1` seeded into a real workspace — 200 documents,
5,393 chunks, 22 scored questions.

## Results

All four rows from one run, over one load of the corpus:

| | recall@1 | recall@5 | recall@10 | complete@5 | complete@10 |
| --- | --- | --- | --- | --- | --- |
| **hybrid (FTS + vector, RRF)** | 0.36 | **0.82** | **0.86** | **0.50** | **0.59** |
| vector only | 0.27 | 0.77 | 0.82 | 0.45 | 0.55 |
| keyword only | 0.18 | 0.18 | 0.18 | 0.18 | 0.18 |
| vector only, index forced off | 0.27 | 0.77 | 0.82 | 0.45 | 0.55 |

The last row is the same vector query with `enable_indexscan` off — an exact
scan of the same rows. It is there because "hybrid beats vector" is a weak claim
if hybrid's vector arm was running approximately and the comparison carried the
same handicap. It does not: hybrid at 0.86 / 0.59 beats an exact vector-only
scan at 0.82 / 0.55.

**Both numbers are asserted, not just printed.** Recall@10 and complete@10 are
each held against vector-only and against the exact scan, four assertions. For
a while only recall was: a change could have halved the number of questions
whose *whole* evidence set was retrieved while recall@10 — satisfied by any one
expected passage — stayed flat and the suite stayed green. Since the report
leads on complete@10, that was the measure most worth protecting and the one
left unprotected. The gap between the two columns is exactly the multi-passage
questions, which are the ones a citation-checked answer depends on.

**Which numbers reproduce, and which do not.** The forced-exact row is
deterministic: 0.27 / 0.77 / 0.82 / 0.45 / 0.55 on every load and every run,
matching the Python brute-force baseline. The `vector only` row is not, because
the HNSW graph is rebuilt on every load and its structure depends on insertion
order — a different load of the *same corpus* produced 0.73 / 0.77 there instead
of 0.77 / 0.82. Within one load it is stable; three consecutive runs returned
identical figures.

**That, not the tie-break and not the row count, is what moves recall@1.**
Hybrid scores 0.36 on this load and 0.32 on the previous one, tracking its
vector arm exactly. The two earlier explanations offered in this report — UUID
tie-breaking, then the plan the planner chose — were each real bugs, and neither
was the remaining cause. So @1 is reported as 0.32-0.36 against a stable 0.27,
without emphasis.

**What does reproduce is the part the argument rests on.** recall@5, recall@10,
complete@5 and complete@10 have come back identical on every run, across both
index builds and both plans. "Every measure improves" stays withdrawn; "the
measures that matter improve and hold still" is what the data supports.

## Which plan you get, and why it matters

Two things vary underneath a measurement that looks fixed. The HNSW graph
differs per build, which the section above covers. The other is the plan: the
same query over the same content returns different results depending on whether
the planner reaches for that index or scans exactly, and **which one you get is
not something this report can predict.**

An earlier version of this section tried. It paired a row count with a plan and
a set of numbers — 5,393 rows with an exact scan, 10,786 with HNSW — as though
the first caused the second. That does not survive contact with the database:
two consecutive runs of the measurement suite, over an unchanged single-tenant
table of 5,393 rows with nothing between them but an `ANALYZE`, chose *exact*
and then *HNSW*. Row count is one input to the planner among several, and the
mapping was a coincidence recorded as a rule.

So the plan is no longer inferred from the state of the table. Two things
replace it:

- The measurement takes `EXPLAIN` **inside the transaction it measures in**, for
  the query shape it actually issues, and prints it beside the numbers. A plan
  sampled in a separate transaction — which is what the previous version did —
  is a plausible guess about a run, not a record of it.
- The cost of approximation is measured directly, by running the same vector
  query a second time with `enable_indexscan` off. That is the `vector only,
  index forced off` row above. It is reproducible on demand, in one run, rather
  than depending on catching the planner in a particular mood.

Those forced-exact figures match the Python brute-force baseline to the decimal,
which is what identifies the difference as approximation rather than a bug.

Three consequences, none of them cosmetic.

**Retrieval quality is not a property of the code alone.** It depends on a
decision made at runtime that can change with no change to the query or the
data. Before comparing two measurements, check they ran under the same plan; if
they did not, they are measurements of two different things.

**The keyword arm has been seen both ways, which makes the same point again.**
An earlier run of `EXPLAIN` showed it using the `workspace_id` btree and
filtering on the tsvector afterwards — linear in the tenant's chunk count. The
run recorded here shows a bitmap index scan on `document_chunks_tsv_idx`, the
GIN index, matching 23 rows in 0.7 ms. Same query, same corpus, different
choice. Neither observation generalises, and the previous version of this report
stated the first as a property of the system.

**Hybrid is the robust one, and that is the finding.** Its recall@5, recall@10
and both completeness figures have come back identical on every run — across two
index builds and both plans, in states where the vector arm alone moved by five
points. Hybrid's own vector arm is the approximate one and it still beats an
exact vector-only scan. Fusion absorbs variation that vector-only transmits,
which is a better argument for hybrid retrieval than the headline improvement.

**The keyword arm is weak alone and still earns its place.** 0.18 flat across
every k, yet adding it lifts recall@5 from 0.77 to 0.82 against the exact
vector-only scan — and from 0.73 on the load where the index build was less
kind. It contributes the exact identifiers, channel names and numbers an
embedding smooths away.

## The multi-tenant ANN problem, and the fix

An approximate index behind a tenant filter has a failure mode with no symptom.
An HNSW scan walks the graph in distance order and discards rows belonging to
other tenants, and by default it stops after `ef_search` candidates whether or
not enough survived the filter. A tenant holding a small share of the table gets
back a short page. No error, no warning, no slow query — retrieval simply stops
finding things, and the smaller the tenant the worse it gets.

`scripts/measure-ann.mjs` measures this against ground truth, which here means
an exact scan of the same rows rather than the labelled dataset. That is a
different question from recall: it asks whether the index returns what an exact
scan would, which is a property of the index alone. The two can move in opposite
directions — an approximation that drops a chunk nobody labelled costs nothing —
so they are kept apart.

**First, the state this report's own reproduction steps produce.** One load,
5,393 rows, one tenant: the planner chose an exact scan for every query and
every variant, including when the query was narrowed to 1.3% of the table.
Agreement 1.00 everywhere, no short pages, and iterative scan makes no
difference because HNSW is never reached. **The problem is not visible at this
size at all** — which is worth saying plainly, because a reader who runs the
documented commands will see nothing and should know that is expected.

Loading the corpus a second time gets a table the planner does reach for HNSW
on. At 10,786 rows across two tenants, querying the workspace holding half:

| | plan | agree | short pages | ms |
| --- | --- | --- | --- | --- |
| exact (ground truth) | exact | 1.00 | 0 | 8.4 |
| HNSW, default | HNSW | 0.95 | 0 | 0.9 |
| HNSW + iterative scan (strict) | HNSW | 0.95 | 0 | 1.0 |

*agree* is the mean fraction of the exact top 20 that came back; *short pages*
counts how many of the 22 queries returned fewer than 20 rows.

A tenant holding half the table is the easy case. Narrowing to a subset of that
tenant's documents stands in for a smaller tenant — what matters to the index is
the share of the table that survives the filter, not what the filter is about:

| share of table | plan | HNSW default | + iterative (strict) | + iterative (relaxed) |
| --- | --- | --- | --- | --- |
| 15.9% | HNSW | 0.20, all 22 short | 0.93, none short | 0.97, none short |
| 3.6% | HNSW | 0.07, all 22 short | 0.96, none short | 0.98, none short |
| 0.7% | exact | 1.00 | 1.00 | 1.00 |

The 0.7% row is not the problem disappearing. The planner abandoned HNSW there
and scanned exactly, which is correct and does not scale — the same trade
arriving from the other side.

**Two things make this a worst case, and both should be stated.** The second
tenant holds the *same 200 documents*, so every one of its chunks is a
near-duplicate of one of ours competing at an almost identical distance — the
most hostile possible arrangement for a filtered graph walk. And the plan column
is what the planner actually chose per query, recorded in the transaction that
ran it; an earlier version of the script sampled it separately and printed
"exact" beside an agreement of 0.97, which no exact scan can produce.

Tenants with genuinely different content would see something milder than 0.07.
Nothing here measures how much milder.

**Fixed by `set local hnsw.iterative_scan = strict_order`** in
`vectorCandidates`, which pgvector 0.8 provides: keep pulling candidates until
the limit is satisfied, capped by `hnsw.max_scan_tuples` (20,000 by default). It
costs nothing measurable at this size, does nothing at all when the planner
scans exactly, and turns 0.07 into 0.96 when the planner does not.

`strict_order`, though `relaxed_order` measured two to three points higher.
Relaxed order returns rows only approximately sorted by distance while still
presenting itself to the planner as ordered — and the plan for this query puts
an incremental sort on top of the index scan, which assumes its input *is*
sorted by distance. Feeding it relaxed output yields an order that is neither
the index's nor sorted. RRF scores by rank position, so an order the planner has
quietly mangled costs more than two points of agreement.

### The setting does not enforce itself

That one line makes pgvector 0.8 a hard requirement, and the obvious assumption
about what happens without it is wrong. It would be comfortable to think an
older pgvector rejects an unknown setting and fails loudly. Checked against the
server rather than assumed, it does not:

pgvector registers its settings when its shared library loads, and that happens
on first use of a vector operation, not at connection time. Until then
PostgreSQL treats any `hnsw.*` name as an unvalidated placeholder.
`vectorCandidates` issues its `set local` *before* the query — precisely that
window — so on an older server the SET succeeds, the library then loads, and
PostgreSQL answers with `WARNING: invalid configuration parameter name
"hnsw.iterative_scan", removing it` and drops it. A warning on a connection
nobody reads, and a short page of results. Later transactions on that same
connection *do* raise, because the prefix is reserved once the library is
loaded, so the symptom is not even consistent.

So the floor is enforced where it cannot be bypassed:

- a migration that refuses to run below pgvector 0.8.0, comparing versions as
  integer arrays so that 0.10.0 is not judged older than 0.8.0;
- the same check in the compose container's init SQL, since the two
  initialisation paths share no files;
- `/api/health/ready`, which reports `vectorSearch: false` and 503s — for a
  database restored or repointed under a running deployment without migrations
  being re-applied;
- a pinned image, `pgvector/pgvector:0.8.2-pg17` rather than the floating
  `pg17` tag, matching what the Supabase local stack ships;
- an integration test that sets the GUC in the same order retrieval does, runs
  a vector operation, and checks what survived.

What this does **not** fix: `max_scan_tuples` is a cap, so a small enough tenant
in a large enough table will still come up short. Iterative scan defers the
problem rather than removing it, and the remedy past that point is partitioning
or a per-tenant index. Neither is needed at this size, and neither has been
tried.

## A measurement bug that made recall@1 meaningless

Fused results were tie-broken on `chunk_id` — a UUID minted at insert time.
Equal RRF scores are common, since every chunk found by a single search at a
given rank ties with every other such chunk, so at k=1 the winner was decided by
which UUIDs a particular load happened to generate. Three runs of the same corpus
produced 0.27, 0.32 and 0.36.

Ties now break on `(document title, chunk ordinal)`, which is derived from the
corpus and survives a reload. Fixing it made the forced-exact vector figures
reproduce to the decimal, which they had not before.

It did not make recall@1 reproduce, and this report claimed for a while that it
had. Two more causes were underneath: the plan, and the index build. Each fix
was real and each was announced as the explanation before the next run
disagreed. The measurement now pins what it can — exact scan for ground truth,
plan recorded per run, ties broken on content — and reports @1 as a range rather
than continuing to look for the last cause.

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
pnpm --filter @clientatlas/product-api exec node scripts/measure-ann.mjs gitlab-handbook-v1
```

**Expect the vector-only and @1 figures to differ from those recorded here.**
Every load rebuilds the HNSW index, and a fresh graph ranks the borderline cases
differently; the forced-exact row and hybrid's @5/@10/completeness figures are
what should reproduce. The ANN measurement will also show nothing interesting on
a single load — the planner does not reach for HNSW at 5,393 rows. Load twice to
see the case that section is about.

Every load also leaves its tenant behind, so the second run measures a larger
table. The loader prints how many rows are not yours for that reason. To get
back to a single-tenant table:

```sql
delete from organizations where slug like 'eval-%';
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
