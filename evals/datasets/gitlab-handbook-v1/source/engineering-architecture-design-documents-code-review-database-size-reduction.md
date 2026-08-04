---
slug: engineering-architecture-design-documents-code-review-database-size-reduction
title: "Code Review database size reduction for GitLab.com"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/code_review_database_size_reduction/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: "Code Review database size reduction for GitLab.com"
status: proposed
creation-date: "2026-04-15"
authors: [ "@zhaochen.li" ]
coaches: [ ]
dris: [ "@francoisrose", "@phikai", "@patrickbajao", "@dskim_gitlab" ]
owning-stage: "~devops::create"
participating-stages: []
toc_hide: true
---

{{< engineering/design-document-header >}}

## Summary

The Code Review group owns several of the largest tables on GitLab.com, including
`notes` (3,054 GB), `events` (2,371 GB), `merge_requests` (787 GB), and
`merge_request_diffs` (389 GB). Together these tables consume over 6,600 GB of
primary database storage and continue to grow, particularly as AI tooling
accelerates record creation.

This document proposes approaches to reduce the on-disk size of these
tables by approximately 50% through a combination of strategies: clearing cached
HTML fields for stale records, converting column types to more compact
representations, removing redundant columns and indexes, decomposing position
data into structured tables, enforcing retention policies, and reclaiming table
bloat. The strategies are prioritized by estimated savings, implementation effort,
and risk.

Related: [Blueprint for Code Review database size reduction (&20233)](https://gitlab.com/groups/gitlab-org/-/epics/20233),
[Code Review database size reduction (#17571)](https://gitlab.com/groups/gitlab-org/-/work_items/17571),
[Initial spike for database size reduction blueprint (#586185)](https://gitlab.com/gitlab-org/gitlab/-/issues/586185).

## Motivation

Large tables on GitLab.com are a major problem for both operations and
development. As tables grow beyond hundreds of gigabytes, several problems
compound:

1. **Query performance suffers.** Larger tables increase index sizes, slow down
   sequential scans, and reduce buffer cache hit rates.
1. **Table maintenance becomes expensive.** `VACUUM`, `ANALYZE`, and index
   rebuilds take longer and hold locks that affect application availability.
1. **Infrastructure costs increase.** Storage, I/O, replication lag, and backup
   times all scale with on-disk size.
1. **Data migrations become complex.** Schema changes on large tables require
   significantly more effort to implement and are more likely to cause stability
   problems on GitLab.com. For example, swapping bigint columns with integer
   columns on `merge_requests` had to be split into 3 stages and took several
   months to complete
   ([#507695](https://gitlab.com/gitlab-org/gitlab/-/work_items/507695)).
1. **Operational risk grows.** Failovers and disaster recovery become slower and
   more fragile as data volume increases.

The [Database Scalability blueprint](/handbook/engineering/architecture/design-documents/database_size_limits/)
(June 2021) established a target of keeping individual physical tables under
100 GB on GitLab.com. Nearly five years later, multiple Code Review tables on GitLab.com still
exceed this threshold by 7x to 30x and have grown significantly since the
original analysis. Without intervention, these tables will continue to grow as
GitLab.com usage increases.

The tables over 100 GB on GitLab.com owned by or closely related to Code Review,
as of January 2026, are:

| Table | Size |
|---|---|
| `merge_request_diff_commits` | 7,875 GB |
| `merge_request_diff_files` | 3,290 GB |
| `notes` | 3,156 GB |
| `events` | 2,371 GB |
| `merge_requests` | 787 GB |
| `merge_request_diffs` | 451 GB |
| `note_diff_files` | 170 GB |
| `approval_merge_request_rules_users` | 160 GB |
| `merge_request_metrics` | 140 GB |

This document focuses on the remaining large tables after excluding the items
listed in [Non-Goals](#non-goals) below: `notes`, `events`, `merge_requests`,
and `merge_request_diffs`.

### Goals

1. Reduce the combined on-disk size of `notes`, `merge_requests`,
   `merge_request_diffs`, and `events` tables by approximately 50%.
1. Achieve the largest savings with the lowest-risk changes first (quick wins),
   then progress to larger structural changes.
1. Maintain backward compatibility with existing application behavior with no
   user-facing feature regressions.
1. Establish repeatable patterns (for example, HTML cache clearing, retention policies) that
   other groups can adopt for their own large tables such as `issues` and
   `work_items`.
1. Update application and model code when needed to support larger structural
   changes (for example, table decomposition, column type conversions).
1. Deliver changes incrementally across multiple milestones, with each change
   independently valuable.

### Non-Goals

This document does not cover the two largest Code Review tables,
`merge_request_diff_commits` and `merge_request_diff_files`. Those tables are
already being addressed by separate epics:

- [Reduce the growth and size of the merge_request_diff_commits (&16385)](https://gitlab.com/groups/gitlab-org/-/epics/16385)
- [Partition and reduce size of merge_request_diff_files (&11272)](https://gitlab.com/groups/gitlab-org/-/epics/11272)

See [Out-of-scope opportunities](#out-of-scope-opportunities) below for other
opportunities identified during the investigation that are not initially in
scope.

## Proposal

The tables below summarize all in-scope opportunities in the order we intend
to pursue them. We split the work into two tracks that can run in parallel:
large initiatives and small initiatives. We plan to execute the work in the
order specified below, with the two tracks proceeding concurrently. Items may
be reordered if a blocker (for example, parallel work on the same table) makes
the next item unworkable in the moment.

Detailed analysis for each opportunity follows in the per-table sections.

### Large initiatives

Sequenced by impact and readiness. The two HTML cache clearing items
(`note_html` on `notes` and `description_html`/`title_html` on `merge_requests`)
are grouped first because they share the same `CacheMarkdownField` pattern and
can be implemented together. The `merge_request_diffs` retention policy sits
ahead of the position columns decomposition because it has a higher expected
ceiling, but as a breaking change it requires navigating customer impact — we
will adjust the order based on that assessment.

| Opportunity | Table | Effort | Savings |
|---|---|---|---|
| Clear `note_html` for stale MRs | `notes` | Large | 1,000 GB |
| Clear `description_html` and `title_html` for stale MRs | `merge_requests` | Large | 150 GB |
| Decompose system notes | `notes` | Large | 800 GB |
| Retention policy on `merge_request_diffs` | `merge_request_diffs`, `merge_request_diff_commits`, `merge_request_diff_files` | Large | TBD (expected large) |
| Convert position columns to structured table | `notes` | Large | 200 GB |
| **Subtotal** | | | **~2,150 GB + TBD** |

**Retention policy on `merge_request_diffs`.** Discussed in
  [issue #594843 (comment)](https://gitlab.com/gitlab-org/gitlab/-/issues/594843#note_3194219248).
  We expect savings to be large because a retention policy on
  `merge_request_diffs` would also reduce `merge_request_diff_commits` and
  `merge_request_diff_files`, but this overlaps with the separate epics already
  addressing those tables
  ([epic &16385](https://gitlab.com/groups/gitlab-org/-/epics/16385) and
  [epic &11272](https://gitlab.com/groups/gitlab-org/-/epics/11272)) and needs
  to be coordinated there. A savings estimate should be produced as part of
  that coordination.

### Small initiatives

Mostly ordered by ROI (savings per unit of effort). `merge_request_diffs` items
are lifted toward the top so this table can make progress in parallel with the
large `notes` and `merge_requests` work. `merge_params` clearing is intentionally
last among the `merge_requests` small items because it is the most
behavior-sensitive of the group.

| Opportunity | Table | Effort | Savings |
|---|---|---|---|
| Reclaim bloat (`pg_repack`) | `merge_requests` | Small | 123 GB |
| Convert SHA columns to `bytea` | `merge_request_diffs` | Small | 78 GB |
| Convert integer columns to smaller types | `merge_request_diffs` | Small | 10 GB |
| Drop redundant noteable index | `notes` | Small | 63 GB |
| Drop `external_diff` column and index | `merge_request_diffs` | Small | 52 GB |
| Drop `updated_at` column | `events` | Small | 34 GB |
| Drop/convert `index_notes_on_line_code` | `notes` | Small | 34 GB |
| Convert `index_notes_on_organization_id` to partial | `notes` | Small | 19 GB |
| Convert SHA columns to `bytea` | `merge_requests` | Small | 15 GB |
| Convert `merge_status` to `smallint` | `merge_requests` | Small | 3.5 GB |
| Drop `assignee_id` column and index | `merge_requests` | Small | ~2.7 GB |
| Remove `merge_params` for merged MRs | `merge_requests` | Small | 25 GB |
| **Subtotal** | | | **~459 GB** |

**Combined total across both tracks: ~2,604 GB + TBD.**

### Out-of-scope opportunities

The following opportunities were identified during the investigation but are
not in scope for this design document. Each is documented here for visibility
and future follow-up:

| Opportunity | Table | Effort | Savings |
|---|---|---|---|
| 90-day retention policy | `events` | Large | 1,800 GB |
| Partition `events` table | `events` | Medium | 0 GB (enabler) |
| Merge namespace columns | `events` | Large | 50 GB |
| Drop `st_diff` column | `notes` | Medium | 20 GB |
| Drop `confidential` column | `notes` | Small | ~0.1 GB |

These are out of scope for the following reasons:

- **`events` table changes (90-day retention, partitioning, and merging
  namespace columns).** These approaches are not yet mature enough to commit
  to in this document. Code Review co-owns the `events` table because it
  contains MR-related data, but many of the features that rely on this data
  are owned by other groups, so changes here require cross-team collaboration
  and further POC work to validate feasibility, impact, and retention
  semantics. The
  [retention policy proposal (#571288)](https://gitlab.com/gitlab-org/gitlab/-/issues/571288)
  is the current starting point for that discussion.
- **Drop `st_diff` column.** Requires removing `LegacyDiffNote` handling
  across the application, which has a broader scope than a column-level change
  and is better tracked as a separate deprecation.
- **Drop `confidential` column.** Savings are negligible (~0.1 GB) and do not
  justify prioritizing this over larger opportunities. Can be finalized
  opportunistically alongside other `notes` changes.

The following sections provide detailed analysis for each opportunity, organized
by table. Each includes context from the
[initial spike investigation](https://gitlab.com/gitlab-org/gitlab/-/issues/586185).

### `notes` table (3,054 GB total: 2,246 GB columns + 808 GB indexes)

The `notes` table is the third largest table on GitLab.com. The top six columns
by size are `note_html`, `note`, `original_position`,
`position`, `discussion_id`, and `change_position`.

#### Clear `note_html` for stale merge requests

- **Estimated savings:** 1,000 GB (44.5% of `notes` table)
- **Effort:** Large

`note_html` is a cached rendered version of the `note` field, generated by
`CacheMarkdownField`. It consumes 1,169 GB (52% of the table). For notes on
merge requests that have not been accessed recently, this cached value can be
cleared and regenerated on demand.

The approach:

1. Define "stale" criteria: for merged MRs, for example `updated_at` older than 3 months;
   for open MRs, `updated_at` older than 6 months.
1. Run an async worker to set `note_html` to `NULL` for notes belonging to stale
   MRs.
1. On read, if `note_html` is `NULL`, regenerate from `note` and persist back to
   the database. The existing `CacheMarkdownField` module already supports this
   pattern through `cached_markdown_version`.
1. Benchmark the performance impact of on-the-fly regeneration for API endpoints
   that return many notes (for example, merge request discussions API).

There have been past markdown cache version bumps (for example, `492f0853`, `e7a98807`) which
essentially trigger the same regeneration, suggesting the performance impact
is manageable.

This pattern can later be applied to `description_html` and `title_html` on
`merge_requests`, `issues`, and `work_items` tables. Nicolas Dular from the Plan
group has expressed support for this approach and noted it could also benefit the
`issues` table.

#### Decompose system notes

- **Estimated savings:** 800 GB (35.6% of `notes` table)
- **Effort:** Large

Approximately 79% of notes rows are system-generated notes. Unlike user-authored
notes, system notes are mostly structured data rendered into full text (for
example, "added 3 commits", "changed the description", "mentioned in !1234"). Instead of
storing the full rendered text, we can store only the structured parameters
needed to reconstruct the message on the fly (for example, action type, count, reference).

There are two possible approaches:

- **Decompose into a new table.** Move system notes into a dedicated
  `system_notes` table with structured columns for each action type. This
  reduces the effective size of both the original and new tables, improving
  query performance for each access pattern.
- **Add structured columns to the existing table.** Add columns for the
  structured parameters and clear the `note` and `note_html` text fields for
  system notes, avoiding the complexity of a table split while still reclaiming
  the storage.

#### Convert `position`, `original_position`, and `change_position` to a structured table

- **Estimated savings:** 200 GB (3.9% of `notes` table)
- **Effort:** Large

These three columns store YAML-serialized position data for `DiffNote` records.
Currently each field is a YAML string consuming approximately 520 bytes per row.
Converting to a structured table (similar to the existing `DiffNotePosition`
model and its `diff_note_positions` table) reduces storage to approximately
350 bytes per row.

Additionally, `position` holds the exact same data as `original_position` for
approximately 2.28% of rows. This redundancy can be eliminated.

We investigated whether converting from YAML strings to `jsonb` would help, but
YAML strings actually use less space than `jsonb` due to TOAST compression.
The structured table approach provides the best savings.

#### Drop redundant `noteable_id`/`noteable_type`/`system` index

- **Estimated savings:** 63 GB (2.1% of `notes` table)
- **Effort:** Small

The composite index `index_notes_on_noteable_id_and_noteable_type_and_system` is
63 GB and has minimal usage. We need to evaluate whether queries can be served by other existing
indexes before removal.

#### Drop or convert `index_notes_on_line_code` to partial

- **Estimated savings:** 34 GB (1.1% of `notes` table)
- **Effort:** Small

This index is 36 GB. Grafana metrics show it is seldom used (fewer than 0.8
scans per second with occasional spikes). The only usage found is for
`LegacyDiffNote`, which is a legacy implementation (new diff notes are of type
`DiffNote`, and mainly `import` still creates the legacy type). This index can be
converted to a partial index or dropped after confirming no active query paths
depend on it.

#### Drop `st_diff` column and remove `LegacyDiffNote` type

- **Estimated savings:** 20 GB (0.7% of `notes` table)
- **Effort:** Medium

The `st_diff` field is only used by `LegacyDiffNote`. We can standardize the
legacy notes type and remove this column, saving approximately 20 GB.

#### Convert `index_notes_on_organization_id` to partial

- **Estimated savings:** 19 GB (0.6% of `notes` table)
- **Effort:** Small

This index is 19 GB but has near-zero usage over the past 90 days. The column
`organization_id` is almost entirely `NULL` (only 451 KB of actual data). There
is no actual usage in application code; the index exists solely for the
Cells/Organization sharding initiative. Converting to a partial index on
`WHERE organization_id IS NOT NULL` shrinks the index from 19 GB to near zero.
This requires confirmation from the Tenant Scale team.

#### Drop `confidential` column (migrated to `internal`)

- **Estimated savings:** ~0.1 GB
- **Effort:** Small

The `confidential` column is a duplicate of `internal` after the migration in
[Rename confidential column in notes tables (#367923)](https://gitlab.com/gitlab-org/gitlab/-/issues/367923).
Finalize the migration by dropping the column and the associated
`index_notes_on_id_where_confidential` index (22 MB).

#### Total estimated savings for `notes`: ~1,700 GB (56%)

### `merge_requests` table (787 GB total: 551 GB columns + 254 GB indexes)

The `merge_requests` table total size is 804 GB (including ~123 GB of
reclaimable bloat). The top columns by size are `description` and
`description_html` (251 GB, 45.6%), `title` and `title_html` (41 GB, 7.45%),
and `merge_params` (26 GB, 4.73%).

#### Clear `description_html` and `title_html` for stale merge requests

- **Estimated savings:** 150 GB (19.9% of `merge_requests` table)
- **Effort:** Large

`description_html` consumes 160 GB and `title_html` consumes 27 GB. Both are
`CacheMarkdownField` caches, not sources of truth. Only `title` and
`description` are the source of truth. The same approach described for
`note_html` above applies here.

#### Reclaim table bloat (`pg_repack`)

- **Estimated savings:** 123 GB (18.8% of `merge_requests` physical size)
- **Effort:** Small (requires DB team coordination)

Analysis shows a 151 GB difference between the physical table size (551 GB) and
the actual column data (400 GB). This is attributed to: table bloat (~123 GB of
reclaimable dead tuples), row metadata (~11 GB), and alignment padding and page
headers (~17 GB). The bloat is likely caused by the bigint migration and
description updates. Running `pg_repack` or `VACUUM FULL` can reclaim this space,
coordinated with the Database team for production execution.

#### Remove `merge_params` for merged merge requests

- **Estimated savings:** 25 GB (3.8% of `merge_requests` table)
- **Effort:** Small

`merge_params` contains highly repetitive data. For example,
`force_remove_source_branch: '0'` is the default behavior for any MR, yet it is
persisted for every row. After an MR is merged, `merge_params` is no longer
needed by the application. Most of this data is also available in Gitaly if
needed later.

Discussion with the Code Review backend team on Slack confirmed there is no known
usage of `merge_params` after the MR is merged. We can run an async worker
daily or weekly to clear `merge_params` for MRs merged more than 7 days ago,
reducing the column from 26 GB to under 1 GB. The `merge_params` field could
also be converted to `jsonb` if we choose not to decompose it into a separate
table.

#### Convert SHA columns to `bytea`

- **Estimated savings:** 15 GB (1.9% of `merge_requests` table)
- **Effort:** Small

Three SHA fields are stored as `character varying`, which uses a hex-encoded
text representation:

- `squash_commit_sha`: varchar field takes 42 bytes, `bytea` takes 20 bytes.
  65.7M rows x 22 bytes saved = 1.31 GB.
- `merge_commit_sha`: varchar field takes 42 bytes, `bytea` takes 20 bytes.
  272.3M rows x 22 bytes saved = 5.99 GB.
- `merged_commit_sha`: varchar field takes 82 bytes (double-encoded), `bytea`
  takes 20 bytes. 121.4M rows x 62 bytes saved = 7.53 GB.

This standardizes SHA storage. The existing `in_progress_merge_commit_sha`
column already uses `bytea`, so there is precedent in this table.

#### Convert `merge_status` from `varchar` to `smallint`

- **Estimated savings:** 3.5 GB (0.5% of `merge_requests` table)
- **Effort:** Small

`merge_status` is defined as `character varying(510)` but only stores 7 possible
enum values (`unchecked`, `preparing`, `checking`, `can_be_merged`,
`cannot_be_merged`, `cannot_be_merged_recheck`, `cannot_be_merged_rechecking`).
Each row consumes approximately 11 bytes. Converting to `smallint` (2 bytes)
with a Rails enum mapping saves approximately 10 bytes per row, with no change
above the model layer.

#### Drop legacy `assignee_id` column

- **Estimated savings:** ~2.7 GB (column + index)
- **Effort:** Small

The `assignee_id` column has been replaced by `merge_request_assignees`
association. The column itself is only 43 MB, but the associated index
`index_merge_requests_on_assignee_id` is 2.62 GB. Both can be dropped after
confirming the deprecation is complete.

#### Total estimated savings for `merge_requests`: ~311.5 GB (47.6%)

### `merge_request_diffs` table (389 GB total: 203 GB columns + 186 GB indexes)

#### Drop `external_diff` column and index

- **Estimated savings:** 52 GB (13.4% of `merge_request_diffs` table)
- **Effort:** Small

The `external_diff` column is no longer populated. It was computed on the
Carrierwave side. The column and its associated index
`index_merge_request_diffs_on_external_diff` (14 GB) can be removed, saving
approximately 52 GB total.

#### Convert 3 SHA columns to `bytea`

- **Estimated savings:** 78 GB (20.1% of `merge_request_diffs` table)
- **Effort:** Small

`base_commit_sha`, `start_commit_sha`, and `head_commit_sha` can be converted
from `character varying` to `bytea`, following the same approach as the
`merge_requests` SHA columns. Each index on these columns also shrinks by
approximately one-third.

#### Convert `real_size`, `state`, `external_diff_store`, and `commits_count` to smaller integer types

- **Estimated savings:** 10 GB (2.6% of `merge_request_diffs` table)
- **Effort:** Small

These columns currently use larger integer types than necessary. Converting to
1-byte or 2-byte integers where the value range permits saves approximately
10 GB.

#### Total estimated savings for `merge_request_diffs`: ~140 GB (36%)

### `events` table (2,371 GB)

The `events` table has a clean schema with limited optimization potential at the
column or index level. The table definition is well-designed, and the content
looks well-structured in terms of what events we store. The primary savings
opportunities come from data lifecycle management.

#### Drop `updated_at` column

- **Estimated savings:** 34 GB (1.4% of `events` table)
- **Effort:** Small

Events are append-only and immutable. Analysis shows only 0.02% of rows have
different `created_at` and `updated_at` values, and most of those differ by only
nanoseconds or milliseconds. Deeper investigation by Abdul Wadood confirmed that
rows where `updated_at` and `created_at` differ by more than 10 seconds have not
occurred in the last year (the last such rows are from 2024).

There is no index on `updated_at`, which implies it is not actively used for
queries. However, as Shane Maglangit noted, absence of an index does not
definitively prove the column is unused (for example, `namespaces.updated_at` is heavily
used but has no index). We should perform a double-check of application code
before action. If needed for backward compatibility, we can alias `updated_at`
to `created_at` in Rails.

#### Merge `project_id`, `group_id`, and `personal_namespace_id` into `namespace_id`

- **Estimated savings:** 50 GB (2.1% of `events` table)
- **Effort:** Large

The events table stores three separate columns for the owning entity. These
could potentially be merged into a single `namespace_id` column. However,
merging these columns would require joining with the `namespaces` table to find
events (since `projects` is a different table from `namespaces`), which would
slow down already slow event queries. This needs careful benchmarking before
proceeding.

#### 90-day retention policy

- **Estimated savings:** 1,800 GB (75.9% of `events` table)
- **Effort:** Large

This is the single largest opportunity across all tables. Both GitHub and Azure
DevOps offer 90-day event retention. A similar policy would dramatically reduce
the `events` table size. Christina Lohr (`@lohrc`) has
[recommended a 90-day retention period](https://gitlab.com/gitlab-org/gitlab/-/issues/571288),
focused on the fact that `events` is essentially a duplicate of data that can be
found in or reconstructed from other tables.

This strategy requires:

1. Product input on acceptable retention periods.
1. Evaluation of whether historical events can be reconstructed from other data
   sources. Notably, `push_event_payloads` is a highly-entangled table that may
   not be reconstructable, and we need to consider whether we can delete events
   for open issues and MRs.
1. Time-based partitioning of the `events` table to enable efficient partition
   dropping rather than row-by-row deletion (the
   time-decay data pattern describes this
   approach in detail).
1. Archiving events older than 90 days to object storage or a data warehouse for
   compliance and analytics use cases.

One additional idea: identify bot and automation actions and treat them
differently (fewer fields to store, or not saving to DB at all). This could
significantly reduce the table's growth rate, especially as AI tooling increases
record creation. This needs Product input first.

#### Table partitioning

- **Estimated savings:** 0 GB direct (enables retention and improves maintenance)
- **Effort:** Medium

Even without a retention policy, partitioning the `events` table by `created_at`
improves query performance, vacuum efficiency, and maintenance operations. It is
a prerequisite for implementing an efficient retention policy.

Kerri Miller noted that a blend of approaches will serve best in the long term,
and that partitioning might be appropriate even with a short retention period, as
we can use time-based partitions and drop the oldest one every 90 days.

#### Total estimated savings for `events`: ~1,884 GB (if retention is adopted)

## Design and implementation details

Refer to the epic
[Reduce the size of Code Review database tables (#17571)](https://gitlab.com/groups/gitlab-org/-/work_items/17571)
for the detailed design and implementation work.

## Alternative Solutions

1. **[Cells](/handbook/engineering/architecture/design-documents/cells/).** Horizontally
   partitioning GitLab.com into multiple cells distributes data across independent
   databases, which would reduce the size of any single Code Review database. However,
   Cells is a long-term, organization-wide architectural effort and does not address
   the near-term growth of these tables on its own.
1. **Database decomposition.** Following the existing `main`/`ci` decomposition
   pattern, the Code Review tables could be moved into a dedicated database. This
   does not shrink the data, but it relieves the operational pressure that motivates
   this work by moving these tables off the main primary. It is complementary to,
   rather than a replacement for, the size reductions proposed here, and carries
   significant cross-cutting effort (foreign keys, joins, and cross-database
   transactions).
1. **Offload to ClickHouse (columnar store).** GitLab already uses ClickHouse for
   analytics and contributions data, with active proposals to move audit events and
   error-tracking events there. The `events` table is the natural candidate: events
   could be streamed to ClickHouse — which provides columnar storage and high
   compression for analytics and history use cases — while PostgreSQL retains only a
   short hot window. This is an alternative implementation of the archival step
   described under the [90-day retention policy](#90-day-retention-policy) and is
   scoped to the `events` table rather than the text-heavy `notes` and
   `merge_requests` tables.
1. **[Mitigate GCP's 64 TB volume limitation (#2)](https://gitlab.com/groups/gitlab-com/gl-infra/data-access/dbo/-/work_items/2).** Use LVM to bypass the 64 TB per-volume cap without application changes. This buys immediate headroom and has already been deployed for the `ci` database cluster. However, it risks increased latency, reduced performance, and more complex failure modes, making it a last resort backup plan rather than a long-term fix.
