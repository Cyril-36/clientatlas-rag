---
slug: engineering-architecture-design-documents-organization-decisions-010-organization-read-only-mode
title: "Organizations ADR 010: Organization Read-Only Mode"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/organization/decisions/010_organization_read_only_mode/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
owning-stage: "~devops::tenant scale"
title: 'Organizations ADR 010: Organization Read-Only Mode'
description: 'Introduces a per-Organization read-only state used during cross-Cell migration and isolation enablement to block writes on the source Cell while allowing reads, with enforcement at the controller, REST API, GraphQL, GitAccess, container registry, LFS, and Sidekiq layers.'
creation-date: "2026-04-28"
authors: [ "@abdwddd" ]
toc_hide: true
---

## Context

When migrating an Organization from one Cell to another (see the
[Organization Data Migration blueprint](../../organization-data-migration/_index.md)),
there is a window during which data is being copied from the source Cell to
the destination Cell. To guarantee data consistency, the source Organization
must stop accepting writes once the cutover begins, while still allowing
reads so that users are not locked out and ongoing read traffic (clones,
pulls, page views, GraphQL queries) keeps working.

The Cohort B criteria
([Cohort B criteria](../../organization-data-migration/cohorts/criteria_cohort_b.md))
explicitly require customers to accept "brief read-only windows during
migration." Today, GitLab only has an **instance-wide** Maintenance Mode
([Maintenance Mode administration guide](https://gitlab.com/help/administration/maintenance_mode/_index)),
which is too coarse: putting the entire source Cell into read-only would block
every other Organization sharing that Cell.

We need a mechanism that is scoped to a **single Organization**, that:

- Blocks writes on the source Cell for the affected Organization only.
- Leaves all other Organizations on the same Cell fully writable.
- Is enforced consistently across every layer that can mutate state
  (controllers, REST API, GraphQL mutations, Git pushes, Container
  Registry pushes, LFS uploads, Sidekiq jobs, internal services).
- Is observable, auditable, and revertible.

### Related work

This ADR formalizes the design that emerged from an iterative POC. It
supersedes earlier TLG-scoped and Rack-middleware approaches:

- Parent epic: [Organization buildout](https://gitlab.com/groups/gitlab-org/-/epics/20404).
- Driving issue: [POC: Organization-scoped read-only mode (controller-layer enforcement)](https://gitlab.com/gitlab-org/gitlab/-/work_items/594327).
- Superseded TLG-scoped POC: [#590009](https://gitlab.com/gitlab-org/gitlab/-/issues/590009)
  and its Step 2 implementation [!226983](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/226983),
  which used Rack middleware and path-prefix matching. Both were closed in
  favor of controller-layer enforcement keyed off `Current.organization`.
- Current Organization-scoped POC: [!228743](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/228743)
  ships Step 1 (Organization state machine) and a first cut of Steps 2, 3,
  and 5 of the implementation plan.

## Decision

We will introduce an **Organization Read-Only Mode**: a per-Organization
state, modeled as a first-class transition on `Organizations::Organization`,
enforced consistently across every write surface in the application. While
the state is set to `read_only`, reads continue to function and writes for
resources owned by that Organization are denied.

The state carries a `reason` (migration, isolation, incident, billing,
legal) recorded for audit and observability. The reason is not surfaced
to end users in banners or error responses; user-visible copy is generic
(see *User-visible behavior*).

The freeze applies to **org-owned data**: top-level groups, namespaces,
projects, and the resources they contain.

### State model

Read-only is added as a pair of new states on the existing
`Organizations::Stateful` concern, which already drives the Organization
lifecycle (`unconfirmed`, `confirmed`, `active`, `deletion_scheduled`,
`deletion_in_progress`):

- `read_only_initialization` — an intermediate state the Organization
  enters before becoming fully `read_only`. New writes are already
  blocked at every enforcement layer (controllers, REST, GraphQL, Git
  access, Container Registry, LFS), but in-flight org-scoped Sidekiq
  jobs are still allowed to finish, in-flight CI jobs are being
  cancelled, and the cutover readiness check is being evaluated. The
  Organization is *intending* to be read-only but has not yet drained.
- `read_only` — the steady state, entered only after the readiness
  contract in *Cutover readiness* below has converged to zero for the
  required confirmation window.

Transitions are restricted to
`active → read_only_initialization → read_only` and back
(`read_only → active` for the abort/recovery path; the
`read_only_initialization → active` transition exists so an operator
can cancel a cutover before the freeze is complete). The new events
reuse the existing `after_transition :log_transition` audit hook and
the `Gitlab::TenantContainerLifecycle::Stateful::TransitionValidation`
validator already included by
[`app/models/concerns/organizations/stateful.rb`](https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/models/concerns/organizations/stateful.rb),
so transition logging and validation are inherited rather than
re-implemented. Entering `read_only_initialization` or `read_only`
from any `deletion_*` state, or from the pre-confirmation states, is
not allowed. Every entry into and exit from these states is audited
via the existing transition hooks.

Splitting the freeze into an initialization phase and a steady state is
deliberate: write blocking, job draining, CI cancellation, and BBM
pausing are not instantaneous, and conflating "writes are blocked" with
"the Organization has drained" obscures which guarantees hold at any
given moment. Cutover tooling, the banner, and the readiness endpoint
all key off the explicit state rather than inferring it.

The specific enum values, event names, and helper signatures are
implementation details and live in
[#594327](https://gitlab.com/gitlab-org/gitlab/-/work_items/594327)
and [!228743](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/228743).

### Control surfaces

State transitions are driven by:

- **Migration tooling** on the source Cell at cutover start
  (`reason: migration`), and cleared on the destination Cell once the
  Organization has been fully migrated and routing has been switched
  in the Topology Service.
- **Isolation enablement tooling** (`reason: isolation`).
- **Admin / SRE controls** for incident, billing, and legal holds,
  surfaced through the instance Admin area and a Rake task in addition
  to the Rails console.
- **The Rails console**, for operator-initiated transitions during
  migration, isolation, or incident response.

The **default Organization is excluded** from read-only mode. The default
Organization hosts instance-level resources and Self-Managed/Dedicated
deployments (see
[ADR 007](007_self_managed_dedicated_single_organization.md)), where
freezing it would be equivalent to taking the whole instance offline. The
Admin area does not expose a read-only toggle for it, and the underlying
transition guard rejects the operation. For the SM/Dedicated → dotCom
migration case, instance-wide Maintenance Mode is the right tool, not
per-Organization read-only.

### Cutover readiness

Cell-to-Cell Organization migration uses Organization Read-Only Mode as
the *drain* phase before data cutover. Because Redis is per-Cell and
is **not** copied to the destination Cell, any Sidekiq job sitting in
source-Cell Redis at cutover is lost. Read-only therefore must drive the
source Cell to a checkable, zero-in-flight state for the Organization
before cutover proceeds.

The readiness contract is: cutover proceeds only when, for the
Organization on the source Cell, **all** of the following are true:

1. No pending jobs in any Sidekiq queue target the Organization.
2. No scheduled or retrying jobs target the Organization.
3. No jobs targeting the Organization are in flight.
4. No per-Organization cron entries target the Organization (cell-wide
   cron entries do not count; their iteration is filtered, see *Sidekiq
   jobs*).
5. In-progress schema migrations and post-deploy migrations on the
   source Cell have finished, so the destination Cell receives a
   schema-consistent snapshot.
6. Batched background migrations touching org-owned data are **paused**
   on the source Cell as part of entering `read_only`, to be
   **resumed** on the destination Cell after cutover, since the
   migration's progress state moves with the data and the work itself
   is org-scoped.

Three rules apply to how this check is used:

- **Order of operations.** Entering `read_only_initialization` must
  take effect across every enqueue path (controllers, REST, GraphQL,
  Git access) before the readiness check starts. Otherwise new jobs
  land while the check is counting. The transition to `read_only`
  itself happens only after the readiness check converges.
- **Drain confirmation window.** The check is run at least twice with a
  short gap and both runs must read zero. A single-shot zero can race
  a job that was about to be picked up by a worker.
- **Bounded wait, then escalate.** If readiness does not converge
  inside a configured window, the cutover tooling surfaces the workers
  still holding the Organization so an operator can decide whether to
  wait, kill, or abort. Migration cutover is a coordinated
  human-supervised step; silent timeouts are not acceptable.

The readiness check is the gating precondition for the data-copy /
swap-routing steps in the
[Organization Data Migration blueprint](../../organization-data-migration/_index.md).
It is exposed as an admin endpoint and is not a hot path. Jobs are
attributed to an Organization through the same Organization context
that accompanies every job (see *Org-scoping rule* below); the
specifics live in
[#594327](https://gitlab.com/gitlab-org/gitlab/-/work_items/594327).

### Where it is enforced

Enforcement is parameterized by the **current Organization** resolved
from the request via the existing
[`CurrentOrganization` controller concern](https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/controllers/concerns/current_organization.rb),
which sets `Current.organization` once per request. Every enforcement
layer below reads that value rather than re-resolving the Organization
itself.

We deliberately **do not** introduce a Rack middleware for this. Path-
and verb-based middleware enforcement is fragile (routes evolve, the
write/read split is not always reflected in HTTP method, and many
endpoints only know which Organization they belong to after controller
logic has run). The controller / Grape / GraphQL / GitAccess layers
already have, or can cheaply obtain, the resolved Organization, and are
the canonical enforcement surface (see *Alternatives*).

The rule per surface:

- **Controllers.** Reads (`GET`, `HEAD`, `OPTIONS`) allowed; writes
  denied for any non-allowlisted action. HTTP method is not a perfect
  proxy for "no write": some `GET`s
  [trigger DB writes or enqueue Sidekiq jobs](https://gitlab.com/gitlab-org/gitlab/-/issues/586370)
  (audit events on login, lazy backfills), and Geo has historically
  patched these case-by-case with `Gitlab::Geo.secondary?` /
  `read_only?` guards or `SkipSecondary`-style worker concerns. New
  occurrences are expected; those guards should be unified with this
  check, and the Sidekiq drain (see *Sidekiq jobs*) is the backstop
  when one slips through.
- **REST API (Grape).** Reads allowed; non-`GET`/`HEAD` requests
  short-circuit when the current Organization is read-only.
- **GraphQL.** Queries allowed; mutations denied. The check runs
  before resolver execution so no partial state is written for
  batched mutations.
- **Git access (`Gitlab::GitAccess`).** Pulls and clones
  (`git-upload-pack`) allowed; pushes (`git-receive-pack`) denied.
  Covers HTTP and SSH, since both go through `GitAccess`. Wikis,
  snippets, and design repositories follow the same rule.
- **Container Registry.** `pull` allowed; `push`, `delete`, and `*`
  denied.
- **Git LFS.** Downloads allowed; uploads, locks, unlocks, and verify
  denied.
- **Sidekiq.** Org-scoped workers drain; cron workers skip the
  read-only Organization. See *Sidekiq jobs* below for the rationale,
  which is architecturally distinct from the other surfaces.
- **Tokens, automation, integrations, webhooks.** Personal access
  tokens, group/project access tokens, deploy tokens, CI job tokens,
  and inbound webhooks all flow through the controller / Grape stack
  and are covered by the rules above. There is no special bypass for
  "trusted integrations". Outbound webhooks triggered by writes are
  not relevant during read-only because the originating writes are
  blocked.

#### Authentication exemption

Authentication endpoints (sign-in, sign-out, OAuth token issuance, JWT
auth, SAML/SSO callbacks) remain available while the Organization is in
`read_only_initialization` or `read_only`. Without this, users would be
unable to obtain a session to *read* the Organization's data, which
defeats the purpose of allowing reads at all.

This exemption is intentionally narrow and carries known residual risks
that must be handled explicitly:

- **Boundary.** The exemption applies to *authentication controllers*
  (and their Grape equivalents for token endpoints), not to arbitrary
  writes that happen to occur on an authenticated request path. A write
  is exempt only if it is required to complete the authentication
  itself — for example, persisting a new session row, recording an
  audit event for a sign-in attempt, or updating the last-used
  timestamp on the credential that was just used.
- **`users` table writes.** SSO/SAML flows can create entirely new
  `users` rows on first sign-in, and `last_sign_in_at` /
  `last_activity_on` updates fire on every authenticated request.
  For sharding purposes, each `users` row belongs to exactly one
  Organization via `organization_id`, so writes to a `users` row
  **are** gated by that Organization's read-only state. The auth
  exemption splits these two cases:
  - *Updates to an existing `users` row* (`last_sign_in_at`,
    `last_activity_on`, and equivalent per-request timestamps) on
    a user whose owning Organization is in
    `read_only_initialization` or `read_only` are **permitted**
    under the exemption, on the same justification as session and
    audit writes: the row already exists on the source Cell and
    the update is required to complete the sign-in itself.
  - *Creating a brand new `users` row* (first sign-in via SSO/SAML,
    JIT provisioning, or any other flow that would `INSERT` into
    `users`) while the owning Organization is in
    `read_only_initialization` or `read_only` is **not** exempt and
    must be blocked. A row created during the read-only window
    lives only on the source Cell, is not part of the cutover
    snapshot, and would be lost when traffic moves to the
    destination Cell. This is exactly the data-loss class the
    read-only state exists to prevent, and the risk is highest
    precisely when the read-only window coincides with the
    cutover. The auth flow therefore surfaces the standard
    read-only error to the caller in this case rather than
    silently creating an orphan row.

  Cross-Org membership at the product level does not change the
  sharding ownership of the row itself, and therefore does not
  change either of the rules above.
- **Cascading writes.** Some auth-time updates can cascade into
  org-owned state — for example, a write that triggers a Topology
  Service update (`user.cell = …`) during a Cell-to-Cell migration
  window. Cascading writes that would land on org-owned rows of a
  read-only Organization must still be blocked: the exemption is for
  the auth controller itself, not for downstream services it calls.
  Where such cascades exist today they should be audited and either
  deferred, idempotent, or routed to the destination Cell.
- **Assumptions.** We assume (a) the auth-time write set is small and
  enumerable, (b) it does not include any state that the Cell-to-Cell
  migration cutover needs to be consistent on the source Cell, and
  (c) the routing layer directs auth requests to the correct Cell
  during the cutover window. Each of these assumptions should be
  re-validated when adding new auth flows or new auth-time side
  effects.

A failure here is a real race condition (SSO creating a user row on the
wrong Cell, `last_login_at` cascading into a stale topology update), so
new auth-time writes must be reviewed against this exemption rather
than being silently waved through by virtue of being on the auth path.

The specific class names, file paths, error response shape, and
HTTP status codes (`503` vs `403`) are implementation details and
live in [#594327](https://gitlab.com/gitlab-org/gitlab/-/work_items/594327)
and the API documentation produced from the POC.

### Sidekiq jobs

Background jobs are the riskiest write surface because they run outside
the HTTP cycle, and on Cell-to-Cell migration they have an additional
constraint: Redis is per-Cell and is **not** migrated, so any job left in
source-Cell Redis at cutover is lost. The policy is split by job source
and detailed in *Policy* below.

#### Org-scoping rule

The Organization a worker operates for is resolved from
`Current.organization`, replicated to the worker through the existing
job-context mechanism ([!212406](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/212406)):
the context set at enqueue time carries the Organization into the job,
and it is assigned back to `Current.organization` when the worker
executes. It is not derived from worker arguments and not passed as an
extra `perform_async` argument. `Current.organization` is set on every
web and API request, so request-originated jobs carry it by default;
enqueue sites without request context wrap the enqueue in a
`Gitlab::ApplicationContext.with_context(organization: ...)` block —
the existing pattern — rather than introducing a parallel resolution
mechanism.

This is also consistent with data isolation: for isolated
Organizations — and isolation is a precondition for Cell-to-Cell
migration — database queries are scoped to `Current.organization`,
so the context Organization *is* the Organization whose data the
worker can read and write. Scheduling a job that references another
Organization's data is a scheduling bug, not a case the read-only
design needs to resolve.

The rule:

- **All workers executing with `Current.organization` available are
  org-scoped** to that Organization. The read-only state of that
  Organization governs them per the *Policy* below: during
  `read_only_initialization` (the drain phase) queued and in-flight
  jobs run to completion, and once the Organization has reached
  `read_only` (steady state, after the drain has converged) workers
  exit early as a backstop — any job arriving then slipped past the
  front-door blocks.
- **Cron workers are cross-org by default.** They have no request
  context at enqueue. Where a cron worker mutates org-owned data it
  must establish an Organization context (for example, per-iteration
  `with_context(organization: ...)` while looping over
  Organizations), so the same worker-side rule applies per iteration;
  this is tracked in
  [#599101](https://gitlab.com/gitlab-org/gitlab/-/work_items/599101)
  and in the iteration-filter requirement in *Policy* below.

One known gap must be closed for the context mechanism to be
complete: jobs enqueued with only a project or namespace context do
not currently carry the Organization, so it must be derived from the
project or namespace at enqueue time. This is tracked in
[#603918](https://gitlab.com/gitlab-org/gitlab/-/work_items/603918).

#### Policy

Two rules, keyed off how the job got there:

- **Org-scoped workers drain.** Jobs that are already queued or in-flight
  when the Organization enters `read_only` represent work whose
  front-door request was accepted before the freeze. They must run to
  completion on the source Cell. The Sidekiq server middleware does
  **not** skip them. New enqueues are prevented at the controller,
  REST, GraphQL, and Git access layers, so once the freeze is in effect
  no further org-scoped jobs land in the queue. Cutover gates on the
  readiness contract above, which returns true only when every queued,
  scheduled, retrying, and in-flight job for the Organization has
  finished — a real drain, not a silent skip.
- **Cron workers skip the read-only Organization and its projects and
  namespaces.** A Sidekiq server middleware short-circuits cron job
  runs whose resolved Organization is read-only, with a structured
  log. Cell-wide cron workers that iterate org-owned data (Projects,
  Namespaces, and other rows resolving to an Organization) must filter
  to active Organizations inside the iteration, expressed as a join
  (or a sub-select against active Organizations) rather than a
  per-row predicate, so the filter cost is bounded.

The filter is implemented as a single shared scope on every model that
participates. Every cron worker that iterates org-owned data must have
a test that asserts rows belonging to non-`active` Organizations are
not yielded.

#### Loose Foreign Keys (LFK)

LFK deletion workers (`LooseForeignKeys::CleanupWorker` and the
per-table variants such as `LooseForeignKeys::CiPipelinesBuildsCleanupCronWorker`
and `LooseForeignKeys::MergeRequestDiffCommitCleanupWorker`, enumerated
in `Gitlab::Database::LooseForeignKeys::ALLOWED_WORKER_CLASSES`) are
Sidekiq cron workers — they run once per Cell because each Cell has
its own Sidekiq, not because of any cell-aware design in the worker
itself. They consume `loose_foreign_keys_deleted_records` (a
`gitlab_shared` table) and cascade deletes or nullifications to child
rows through a four-step chain: `CleanupWorker` →
`LooseForeignKeys::ProcessDeletedRecordsService` →
`LooseForeignKeys::BatchCleanerService` →
`LooseForeignKeys::CleanerService` (or `PartitionCleanerService` for
partitioned tables). `BatchCleanerService` is the orchestrator that
looks up the LFK definitions for each parent table; `CleanerService`
is the per-table executor that builds and runs the actual
`DELETE` / `UPDATE`. Conceptually the whole chain falls under the
*cron workers skip the read-only Organization* rule above: cascading
deletes against rows belonging to a read-only Organization must not
be applied during the drain.

In practice, `CleanerService` builds raw `DELETE` / `UPDATE` queries
keyed on the loose-FK column (e.g., `WHERE project_id IN (...)`)
rather than iterating an org-owned ActiveRecord scope, so the
active-Organizations filter is not free to slot in. The
implementation work is to resolve the owning Organization for each
tracked child table — either via the sharding-key dictionary
(`Gitlab::Database::Dictionary`, sourced from `db/docs/*.yml` and
already consumed by `Organizations::Sharding`) or by adding an
active-Organizations join to the cleaner's generated query — and to
teach `BatchCleanerService` / `CleanerService` to skip parent records
whose owning Organization is non-`active`. This work belongs with the
LFK feature owners and is tracked alongside the broader
LFK-after-cutover question below.

The broader question of how LFK behaves once an Organization has
*moved* to a destination Cell (i.e., what happens to parent/child rows
left on the source Cell, and how the LFK worker on each Cell should
reason about that) is out of scope for this ADR. It is tracked in
[gitlab-org/gitlab#535508](https://gitlab.com/gitlab-org/gitlab/-/work_items/535508)
and belongs in the
[Organization Data Migration blueprint](../../organization-data-migration/_index.md).

#### Batched Background Migrations (BBMs)

BBMs are scheduled per-database by a family of Sidekiq cron workers
that all include the
`Database::BatchedBackgroundMigration::SingleDatabaseWorker` concern:
`Database::BatchedBackgroundMigrationWorker` (main),
`Database::BatchedBackgroundMigration::CiDatabaseWorker` (CI), and
`Database::BatchedBackgroundMigration::SecDatabaseWorker` (sec). Each
dispatches to its database's execution worker
(`MainExecutionWorker` / `CiExecutionWorker` / `SecExecutionWorker`),
which in turn runs individual jobs through
`Gitlab::Database::BackgroundMigration::BatchedMigrationWrapper`. BBMs
iterate primary-key or cursor ranges over a table — not over
Organizations directly. The
[`queue_batched_background_migration`](https://gitlab.com/gitlab-org/gitlab/-/blob/master/lib/gitlab/database/migrations/batched_background_migration_helpers.rb)
helper auto-detects cursor strategy when a migration defines
`cursor_columns`. BBMs are cell-local: they are scheduled by cron
workers and the org-owned tables they touch do not uniformly carry an
`organization_id` sharding key, so there is no generic per-row
"active Organization" predicate a BBM batch could apply. They are
therefore handled like the other cell-local cron workers — skipped
wholesale on entering `read_only_initialization` rather than filtered
per-Organization.

Per-row work progress (`batched_background_migrations.min_value` /
`max_value` / `batch_size` and the per-batch rows referenced by
`BatchedMigrationWrapper#perform`) is stored in Postgres rather than
Redis. However, only the org-sharded target rows move with the
Organization — the BBM scheduler, job, and transition-log tables
themselves are `gitlab_shared_cell_local` (see below) and remain on
the source Cell.

The policy in this ADR is:

- **BBMs follow the cell-local cron-skip rule.** Like the other
  cell-local Sidekiq cron workers, BBM scheduling is skipped wholesale
  while the Cell is initializing a cutover rather than filtered per
  Organization. BBMs are cell-local and do not run against an
  Organization sharding key, so there is no per-Organization filter to
  apply; pausing the cron-driven scheduling is the BBM equivalent of
  the cron-skip rule.
- **BBMs are paused on the source Cell as part of entering
  `read_only_initialization` and resumed on the destination Cell
  after cutover.** BBM progress is persisted in PostgreSQL
  (`batched_background_migrations`, `batched_background_migration_jobs`,
  and `batched_background_migration_job_transition_logs`) rather than
  in Redis, which is the property that makes resume-after-cutover
  feasible at all. The BBM tracking tables themselves
  (`batched_background_migrations`, `batched_background_migration_jobs`,
  `batched_background_migration_job_transition_logs`) are marked
  `gitlab_schema: gitlab_shared_cell_local` in the database dictionary
  ([`db/docs/batched_background_migrations.yml`](https://gitlab.com/gitlab-org/gitlab/-/blob/master/db/docs/batched_background_migrations.yml),
  [`db/docs/batched_background_migration_jobs.yml`](https://gitlab.com/gitlab-org/gitlab/-/blob/master/db/docs/batched_background_migration_jobs.yml),
  [`db/docs/batched_background_migration_job_transition_logs.yml`](https://gitlab.com/gitlab-org/gitlab/-/blob/master/db/docs/batched_background_migration_job_transition_logs.yml))
  and therefore stay on the source Cell during an Organization move.
  The destination Cell must re-enqueue any in-flight BBMs against the
  moved data as an explicit hand-off step; tracking history is not
  transferred.
- **In-flight BBM batches are not cancelled mid-batch.** Cancellation
  would risk leaving the migration in a partial state. The readiness
  check waits for the current batch to complete before the source Cell
  is considered drained.

The full contract for how the cutover-readiness check reads BBM
progress is shared with the Organization Data Migration blueprint and
tracked in [&20404](https://gitlab.com/groups/gitlab-org/-/epics/20404).

#### Observability

Every skip, cancel, or filter event emits a structured log with
`organization_id`, `worker` (class), and `jid`. The same data is what
the *Cutover readiness* endpoint reads from, so cutover decisions and
steady-state observability share one signal.

This Sidekiq policy is intentionally stricter than instance-wide
Maintenance Mode, which lets all background jobs continue running.

### CI/CD behavior

- Creating new pipelines (UI, API, schedule-triggered, manually triggered)
  for projects under a read-only Organization is blocked.
- Reading pipeline and job state, logs, and artifacts remains allowed.
- **Jobs that started before the Organization entered read-only are
  cancelled**, since they may run for a long time and would otherwise
  hold up cutover indefinitely. Cancellation also covers destructive
  operations (artifact deletion, registry pushes, deployments to
  protected environments) that should not proceed once the Organization
  is frozen.
- New deployments, environment changes, and feature flag changes that
  originate from the read-only Organization are blocked. Reads of
  historic deployment state and environment details remain allowed.

### Allowlist principles

A request is **allowed** during Organization Read-Only Mode when at least
one of the following is true:

- It is a read (`GET`, `HEAD`, `OPTIONS`).
- It is an authentication request (sign-in, sign-out, OAuth token, JWT auth).
- It is a Git read (`git-upload-pack`).
- It is an internal API call required to keep the platform running.
- It is part of the migration or isolation control plane (DMS, Topology
  Service, Organization migration / isolation endpoints).

Everything else is denied by default. The concrete list of allowlisted
controllers, actions, and endpoints lives in
[#594327](https://gitlab.com/gitlab-org/gitlab/-/work_items/594327).

### User-visible behavior

- A persistent banner is displayed on every page rendered for the
  Organization, including group and project pages it owns. The copy is
  generic and does not reveal the internal reason or any infrastructure
  detail (Cell, migration). For example: *"This Organization is
  currently in read-only mode while essential maintenance is performed.
  Reads will continue to work; please retry write operations shortly."*
- The banner reuses the same surface and Vue component pattern as the
  existing instance-wide Maintenance Mode banner, keyed off the
  Organization's `read_only?` state rather than the instance-wide flag.
  This keeps one mechanism, one place to style, and one place to add
  accessibility and internationalization.
- API responses signal read-only with a structured error and an
  appropriate HTTP status (`503 Service Unavailable` with `Retry-After`
  for time-bounded reasons, `403 Forbidden` for non-time-bounded
  reasons). The exact response body and status matrix are implementation
  details (see [#594327](https://gitlab.com/gitlab-org/gitlab/-/work_items/594327)).
- Git pushes return an equivalent generic message: *"Git push is not
  allowed because this Organization is currently in read-only mode."*

### Auditability and observability

The existing transition logging and validation mixins on
`Organizations::Stateful` are reused; no new audit pipeline is
introduced. Each entry into and exit from `read_only` emits an
Organization-level audit event recording the organization id, actor
(system, user, automation), timestamp, and reason.

### Performance and caching

`Current.organization` is resolved once per request; state changes
invalidate any caches via the existing `after_transition` hook.

### Rollout and feature flags

- The mechanism is gated by feature flags, both environment-scoped and
  Organization-scoped, so rollout can proceed cohort-by-cohort.
- On GitLab.com, enable first for internal/test Organizations, then
  expand alongside the existing Organizations rollout cohorts.
- On Self-Managed and Dedicated, ship default-off (see *Consequences*).

## Consequences

- Migration of an Organization no longer requires putting the whole Cell
  (and therefore unrelated Organizations) into Maintenance Mode.
- The same mechanism covers isolation enablement, incident scoping, and
  billing/legal holds, avoiding a proliferation of one-off toggles.
- Enforcement is duplicated across many layers (controllers, Grape,
  GraphQL, GitAccess, Sidekiq). This is intentional (defense in depth),
  but it does increase the surface area we must keep in sync. Each new
  write entry point must explicitly declare whether it honors
  Organization read-only.
- Cell-wide cron workers must adopt the active-Organizations filter when
  iterating org-owned data, and must have tests asserting read-only
  Organizations are filtered out. Without this, new cron workers added
  after the rollout will silently mutate data that is about to be moved.
- Any code path that bypasses the enforcement layers above (for example,
  raw SQL `UPDATE`s in migrations or direct ActiveRecord writes that do
  not go through a controller, Grape, GraphQL, or `Gitlab::GitAccess`)
  is **not** covered by this iteration. A future iteration may add a
  service-layer or model-layer guard as defense in depth.
- The instance-wide Maintenance Mode (`Gitlab.maintenance_mode?`) remains
  available and orthogonal: when both are active, the more restrictive
  state wins, and Organization read-only must not introduce code paths
  that bypass instance maintenance checks.
- Self-Managed and Dedicated instances (single Organization per instance,
  see [ADR 007](007_self_managed_dedicated_single_organization.md))
  inherit this mechanism for free, but in practice they should continue to
  use instance-wide Maintenance Mode because there is no per-Organization
  isolation benefit. The flag is shipped default-off on those topologies.
- Users may be confused when reads work but writes suddenly fail. UX copy
  and the banner-on-every-owned-page requirement exist to mitigate this.

## Alternatives Considered

### 1. Reuse instance-wide Maintenance Mode on the source Cell

Toggling `Gitlab.maintenance_mode?` on the source Cell would block writes,
but it blocks them for **every** Organization on that Cell. This is
unacceptable once Cells host more than one Organization.

### 2. Rely solely on `project.repository_read_only`

This flag exists today and is used during repository storage moves. It only
covers Git-level pushes for a single project; it does not cover REST,
GraphQL, Sidekiq, container registry, packages, or non-repository state.
Using it as the sole mechanism would silently allow most writes during
migration.

### 3. Single chokepoint at the database layer

A `BEFORE UPDATE` trigger keyed on the sharding key would catch every
write. Sharding keys (`organization_id`, `project_id`, or `namespace_id`)
are not yet universally present on all data tables, but the codebase is
moving in that direction; once coverage is complete, the trigger could
resolve the owning Organization on every write. Caveats:

- A naive `PG::Error` surfaced from a trigger produces a poor user
  experience, but this is solvable: PostgreSQL
  [`RAISE`](https://www.postgresql.org/docs/17/plpgsql-errors-and-messages.html#PLPGSQL-STATEMENTS-RAISE)
  with a custom `SQLSTATE` surfaces from the `pg` gem as a generic
  `PG::ServerError` (the `pg` gem's typed subclasses only cover the
  standard SQLSTATE codes, not user-defined ones). ActiveRecord's
  PostgreSQL adapter then routes the exception through
  `translate_exception`, which we can extend in a subclassed adapter
  to match the custom SQLSTATE and re-raise as a dedicated
  `ActiveRecord::OrganizationReadOnlyError` (subclassing
  `ActiveRecord::ReadOnlyError`). The application then rescues a
  single typed exception and turns it into the same user-facing
  response shape as the controller-layer enforcement. With this
  mapping in place the trigger is a viable last-line backstop.
- It does not stop Sidekiq jobs from being enqueued or external systems
  from issuing requests, so the application-layer feedback is still
  necessary.
- Trigger performance needs benchmarking. A per-row trigger that has
  to resolve `organization_id` through a join (when the sharding key
  is not directly on the table) is not free, especially on hot write
  paths.

We may revisit this as a **last-line** safety net once sharding-key
coverage is universal, but it is not sufficient on its own.

### 4. Block at the Topology Service / router

Routing writes for the Organization away from the source Cell during
cutover is part of the migration design, but it cannot be the only
enforcement: in-flight requests, Sidekiq jobs already enqueued on the
source Cell, and direct admin access still need to be stopped at the
application layer. GraphQL also can't easily be blocked using this
method, since the request body would have to be examined in order to
determine the Organization in scope.

### 5. Rack / path-based middleware enforcement

Implementing read-only as a Rack or ingress middleware that inspects URLs
and blocks potentially mutating endpoints based on path patterns is
fragile: GraphQL alone makes path/verb matching insufficient (one
endpoint serves both queries and mutations, with the Organization in
scope only knowable after parsing a potentially batched request body).
See *Where it is enforced* for the controller / Grape / GraphQL /
GitAccess approach used instead.

### 6. Top-level group read-only without an Organization state

Defining read-only at the top-level group / namespace level instead of on
Organizations is misaligned with the Organizations roadmap, where
Organization is the canonical tenant. Under this approach the
Organization itself would remain writable, with only the top-level
group(s) frozen, which leaves Organization-scoped resources (settings,
audit events, and other org-owned state) mutable during migration and
defeats the purpose of the freeze. It also complicates Cell and
isolation work, which already assumes an Organization abstraction for
routing and data movement.

### 7. Derive read-only state from root namespaces instead of an Organization column

An alternative to adding a `state` column on `Organizations::Organization`
is to derive read-only from the `effective_state` of the Organization's
root namespaces. This is simpler in the short term (no schema change,
no new state machine) and was raised as Open Question 1 in
[#594327](https://gitlab.com/gitlab-org/gitlab/-/work_items/594327).

It is rejected because:

- It couples Organization-level read-only to namespace state, which has
  its own lifecycle (deletion, transfer, archiving) and would create
  ambiguous combined states.
- A future multi-TLG Organization would have to aggregate namespace
  states, and the aggregation rule (any vs. all) is itself a policy
  decision better expressed once at the Organization level.
- Audit, observability, and the cutover-readiness contract all want a
  single, authoritative "is this Organization read-only right now?"
  signal. A derived state spreads that signal across N rows.
- The state also needs to express *why* the Organization is read-only
  (migration, isolation, incident, billing, legal). That metadata
  belongs on the Organization, not on each namespace.

The Organization-level state column is what is shipped in the POC
[!228743](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/228743).

### 8. ActiveRecord `before_create`/`update`/`destroy` hooks on every model

Adding a concern that injects `before_create`, `before_update`, and
`before_destroy` callbacks on every model that resolves to an
Organization would, in principle, catch writes at the model layer
without requiring controller/Grape/GraphQL coverage to be exhaustive.

We reject this approach because ActiveRecord callbacks are bypassed by:

- `update_columns`, `update_all`, `delete_all`, `upsert`, `upsert_all`,
  `insert`, and `insert_all` — all skip callbacks by design. The
  singular `insert` and `upsert` are thin wrappers that delegate to
  their `_all` counterparts, so they skip callbacks and validations
  identically. The bypass surface is therefore wider than just the
  explicitly bulk forms (`update_all`, `delete_all`, `upsert_all`,
  `insert_all`) — it also covers `update_columns`, the singular
  `insert`/`upsert`, and any raw SQL executed via the connection.
- Raw SQL in regular and post-deploy migrations.
- Direct `INSERT`/`UPDATE` from Rake tasks or the Rails console.
- Anything going through Arel or `exec_query`.

A chokepoint that is bypassed by the most common bulk-write idioms in
the codebase is not a chokepoint. Callbacks also do not help with the
non-database write surfaces (Sidekiq enqueue, Git push, Container
Registry, LFS) that make up most of what this ADR is trying to cover.

A database-layer trigger (Alternative #3) sits below all of these and
is the right shape for a last-line safety net.

## Granularity

Per-Organization read-only is sufficient. Per
[ADR 008](008_non_isolated_organizations_gitlab_com.md), top-level groups on
GitLab.com are being transferred into Organizations (1:1 by default), so
"the affected unit" is always an Organization. A finer-grained
per-top-level-group or per-project read-only mode is therefore not required.

### Cell-to-Cell migration scope

For Cell-to-Cell Organization migration (the primary use case), the
**entire Organization** is placed in read-only on the source Cell for
the duration of the cutover. This includes every top-level group,
namespace, project, and other org-owned resource. Partial read-only
(some TLGs frozen, others writable) is explicitly **not** supported,
because:

- The migration moves all Organization-owned data atomically; leaving
  any subset writable would create cross-row inconsistencies the
  destination Cell cannot reconcile.
- The cutover-readiness contract above operates at the Organization
  level (Sidekiq queues are filtered by `organization_id`).
- The 1:1 TLG-to-Organization invariant from ADR 008 means there is
  typically only one TLG per Organization on GitLab.com today, so
  partial freezing has no practical use case yet.

## Open Questions

- How to surface the read-only state to GitLab-CLI and editor extensions
  (separate `X-GitLab-Organization-Read-Only` response header?).
- Behavior of long-running write operations (large imports, exports,
  bulk-rebase) that started just before the state change: cancel, drain,
  or fail? The CI policy above covers pipelines but not these.
- Should we use Postgres Row-Level Security (RLS) to block all writes to
  an Organization during migration as a database-level backstop, in
  addition to the application-layer enforcement?
- How do regular and post-deploy schema migrations that mutate org-owned
  rows interact with the cutover window? The current position is to
  treat "no deploys mid-cutover" as an operational rule and revisit a
  database-layer backstop (Alternative #3) once sharding-key coverage is
  universal, but this should be confirmed with the migration tooling DRIs.
- BBM contract: which BBMs need the active-Organizations filter, and
  how does the cutover-readiness check read BBM progress? Tracked in
  [gitlab-org/gitlab#546321](https://gitlab.com/gitlab-org/gitlab/-/work_items/546321)
  and [&20404](https://gitlab.com/groups/gitlab-org/-/epics/20404),
  to be resolved in the Organization Data Migration blueprint.
- LFK behavior on a moved Organization (parent/child rows left on the
  source Cell, source-Cell LFK worker behavior after cutover). Tracked
  in [gitlab-org/gitlab#535508](https://gitlab.com/gitlab-org/gitlab/-/work_items/535508)
  and belongs in the Organization Data Migration blueprint.
