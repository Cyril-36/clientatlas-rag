---
slug: engineering-architecture-design-documents-unified-rate-limiting
title: "Unified Rate Limiting Architecture"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/unified_rate_limiting/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: "Unified Rate Limiting Architecture"
description: "Technical design for unifying application-level rate limiting through labkit in three phases: application unification, externalized configuration, and a dynamic external service."
status: ongoing
creation-date: "2026-04-30"
authors: [ "@reprazent" ]
coaches: [ "@andrewn" ]
dris: [ "@reprazent", "@donnaalexandra" ]
owning-stage: "~devops::platforms"
participating-stages: []
toc_hide: true
---

<!-- vale gitlab.FutureTense = NO -->

{{< engineering/design-document-header >}}

## Summary

Application-level rate limiting in GitLab needs a single configuration model
that works across all implementations (RackAttack, ApplicationRateLimiter, and
future services). This document describes how we get there in three phases,
using [labkit](https://gitlab.com/gitlab-org/labkit) as the shared SDK:

1. Route existing rate limiting (RackAttack, ApplicationRateLimiter) through
   labkit without breaking changes. Configuration still comes from the database
   or is passed in by the application.
2. Add a config file that labkit loads. Rules from the file override the
   application defaults. The format follows the protobuf schema from
   [LabKit Configuration Management](../labkit_configuration/).
3. Add an external service that returns rules per-request, based on the
   identifier. This is what allows per-customer and per-tier customization.

This builds on the [Next Rate Limiting Architecture](../rate_limiting/) blueprint and the [Simplifying Rate Limiting Configuration](../rate_limiting_simplification/) design document. Implementation is tracked in [the Phase 2 epic](https://gitlab.com/groups/gitlab-com/gl-infra/-/work_items/2021).

## Motivation

Rate limiting in the GitLab application is spread across RackAttack,
ApplicationRateLimiter, and several smaller implementations. Each has its own
configuration mechanism, its own counting, and its own observability story. In
practice this means you can't configure all rate limits the same way, dry-run
and bypass behavior varies, new endpoints ship without limits, and during
incidents nobody can quickly tell what's throttled and why.

The [Simplifying Rate Limiting Configuration](../rate_limiting_simplification/)
document describes the phased approach. Phase 1 (edge network) is complete.
This document covers the technical design for Phase 2 (application-level
unification) and outlines Phase 3 (externalized configuration and dynamic
service).

## Phase 1: Application-Level Unification

All application rate limiting goes through a single API in `labkit-ruby`. The
caller (rack middleware or application code) constructs an identifier, passes it
to labkit with a set of rules, and gets back a result. Existing configuration
(ApplicationSettings, env vars, hardcoded defaults) keeps working. The caller
resolves its own configuration and passes it in.

_Unlocks:_ one consistent way to define and observe limits across the
application. Adding or changing a rule still takes a code change and a
deployment, but every limit now behaves and is instrumented in the same way.
Old limits are migrated, new limits automatically get the same benefit.

### 1.1 The labkit rate limiting API

`Labkit::RateLimit::Limiter` is the main entry point. Build one per rate
limiting checkpoint (at boot, not per-request) and reuse it. The internal
`Evaluator` is cached.

```ruby
limiter = Labkit::RateLimit::Limiter.new(
  name: "rack_request",
  rules: [...]
)

result = limiter.check(identifier)
```

The `name` is prepended to all Redis counter keys, so different limiters within
a service never share counters. Limiter names are static per-application
configuration, declared in that service's `available_limiters` (Phase 2), so two
limiters in the same service cannot accidentally collide.

Names can repeat across services: `rack_request` may exist in several, and that
is harmless. Each service counts in its own Redis storage (for GitLab Rails,
the dedicated rate-limiting Redis), so a shared name never means a shared
counter.

### 1.2 Language SDKs

The SDK is not Ruby-specific. Each supported language gets a native SDK with the
same model: build a limiter once, construct an identifier per request, call
`check`, then act on the result. The examples in this document use Ruby for
brevity, but the Go API should mirror them. Both SDKs read the same
configuration files (Phase 2) and talk to the same external service (Phase 3),
so a rule defined once does the same thing whichever language calls it.

<table>
<thead>
<tr><th width="50%">Ruby (<code>labkit-ruby</code>)</th><th width="50%">Go (<code>labkit/v2/ratelimit</code>)</th></tr>
</thead>
<tbody>
<tr>
<td>

```ruby
limiter = Labkit::RateLimit::Limiter.new(
  name: "rack_request",
  rules: [
    Labkit::RateLimit::Rule.new(
      name: "authenticated_api",
      characteristics: [:user],
      limit: 200,
      period_s: 60,
      action: :limit
    )
  ]
)

result = limiter.check(
  user: "user:123",
  request_type: "api"
)

case result.action
when :block then render_429
when :allow then # proceed
end
```

The Ruby SDKs also offer a `check!` convenience that raises for call sites that prefer to
let a middleware at the edge of the application render the `429`. For the first
Rails iteration we handle the result and the response codes ourselves at the
call site (see [1.6](#16-result-object)), and adopt `check!` where the call
sites allow it.

</td>
<td>

```go
limiter := ratelimit.New(ratelimit.Config{
    Name: "rack_request",
    Rules: []ratelimit.Rule{
        {
            Name:            "authenticated_api",
            Characteristics: []string{"user"},
            Limit:           200,
            Period:          60 * time.Second,
            Action:          ratelimit.ActionLimit,
        },
    },
})

result, err := limiter.Check(ctx, ratelimit.Identifier{
    "user":         "user:123",
    "request_type": "api",
})

switch result.Action {
case ratelimit.ActionBlock:
    renderTooManyRequests(w)
case ratelimit.ActionAllow:
    // proceed
}
```

</td>
</tr>
</tbody>
</table>

Defining rules programatically rather than through configuration should be the exception, not the rule. But we have to support this in order not to break self-managed configurations that might have config in the database for this.

### 1.3 Identifier

The identifier is a key-value hash built by the caller with whatever it knows
about the request. Different limiters have different shapes:

**Rack middleware:**

```ruby
{
  request_type: "api",
  user: "user:123",        # or "<anonymous>" for unauthenticated
  ip: "203.0.113.42",
  namespace: 345,
  namespace_plan: "premium",
  endpoint: "GET /api/v4/:id/merge_requests"
}
```

**ApplicationRateLimiter:**

```ruby
{
  user_id: 42,
  project_id: 789,
  namespace_id: 345
}
```

`<anonymous>` uses angle brackets so it can't collide with a real username.
Unauthenticated rules match on `user: "<anonymous>"` and count by `[:ip]`.
Authenticated rules don't match that value, so they act as a fallback and count
by `[:user]`.

### 1.4 Rules and matching

Each rule has:

- **`name`** — stable identifier used in Redis keys, logs, and metrics
- **`match`** — key-value pairs that must all be present in the identifier for
  the rule to apply. Supports equality matching and regex matching via a
  `Matcher` object
  ([#28855](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28855)).
  The Matcher design uses explicit type markers (`{ regex: "..." }`) to ensure
  YAML-round-trippability across languages.
- **`characteristics`** — identifier keys used to derive the Redis counter key.
  The limiter name is always prepended.
- **`limit`** — the threshold. Can be a static integer or a callable (resolved
  at check time) for database-backed values.
- **`period_s`** — the time window in seconds. Can also be a callable.
- **`action`** — what the rule does, `limit`, `log` or `skip` (see 1.4).

### 1.5 Action semantics

Each rule has an `action` that describes what it does. The result returned to
the caller describes the outcome: what the caller should do.

| Rule action | What it does                                 | Exceeded? | Result action | Terminating?               |
| ----------- | -------------------------------------------- | --------- | ------------- | -------------------------- |
| `limit`     | Count against the limit                      | No        | `allow`       | No — continue to next rule |
| `limit`     | Count against the limit                      | Yes       | `block`       | Yes — stop evaluation      |
| `log`       | Count against the limit (observability only) | No        | `allow`       | No — continue              |
| `log`       | Count against the limit (observability only) | Yes       | `allow`       | No — continue              |
| `skip`      | Don't count (bypass)                         | N/A       | `allow`       | Yes — stop evaluation      |

A terminating action stops rule evaluation. Non-terminating actions continue
to the next matching rule.

Multiple `:limit` rules in a single limiter means all of them must pass for the
request to go through (e.g., a per-org limit and a per-user limit). A `:log`
rule can shadow-test a lower threshold without affecting the `:limit` rules
after it. A `:skip` rule at the top of the list handles bypasses.

Rules are evaluated in order. Put more specific rules before less specific ones.

> **Implementation note:** The current labkit implementation uses an earlier
> naming (`:block`, `:log`, `:allow`) which will be renamed to align with this
> design model. The behavioral semantics (non-terminating `:log` per
> [#28890](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28890))
> are already implemented. The full action model refinement is tracked in
> [#29052](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/29052).

### 1.6 Result object

The result carries the outcome and the resolved values:

```ruby
result = limiter.check(identifier)

result.action           # :allow or :block — what the caller should do
result.exceeded?        # whether the count exceeded the limit
result.rule             # the last evaluated Rule object (rule.action has the configured action)
result.error?           # true if Redis was unavailable (fail-open)
result.resolved_limit   # the resolved limit as Integer
result.resolved_period_s  # the resolved period in seconds as Integer
```

The caller is responsible for handling the result. For example:

```ruby
result = limiter.check(identifier)
case result.action
when :block then render_429
when :allow then # proceed
end
```

Eventually, labkit should ship default handlers for the common cases: a rack
middleware that returns 429 with `RateLimit-*` headers, a gRPC interceptor, and
a Sidekiq middleware. These are also natural places for generic resource-scoped
limits (e.g., db_duration_s per user, gitaly score per user) that guard against
runaway consumption without per-endpoint tuning. Until then, callers handle the
result themselves.

### 1.7 Configuration passthrough

We cannot break self-managed installations. So configuration is passed at the
call site: the caller resolves limits from existing sources (ApplicationSettings,
env vars, hardcoded defaults) and passes them to labkit as rules.

`limit` and `period_s` on a rule can be callables. This lets database-backed
settings resolve at check time without rebuilding rule objects:

```ruby
Rule.new(
  name: "authenticated_api",
  limit: -> { ApplicationSetting.current.throttle_authenticated_api_requests_per_period },
  period_s: -> { ApplicationSetting.current.throttle_authenticated_api_period_in_seconds },
  characteristics: [:user],
  action: :limit
)
```

Self-managed and GitLab.com keep working: the callables read from the same
settings they always did. No limits change unless someone explicitly
reconfigures them.

The plan is to replace the current `rate_limits` hash in
`ApplicationRateLimiter` with static labkit `Limiter` objects as the single
source of truth
([#29054](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/29054)).

The end state takes the database out of the rate-limiting hot path, but it does
not take away the admin web-UI. Admins who prefer click-ops keep it. What
changes is where the UI writes: instead of `ApplicationSettings` rows that the
limiter reads on every request, the UI writes rule objects into Redis, which
labkit reads as a rule source (see [2.4](#24-redis-backed-rules-web-ui-configuration)).
GitLab.com leans on the config file and the external service; self-managed gets
the UI-over-Redis path, with a migration that moves existing database values
into the Redis store.

The broader configuration evolution is tracked in
[#28853](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28853).

### 1.8 Migration: ApplicationRateLimiter (Stage 2a)

Behind a feature flag, `ApplicationRateLimiter.throttled?` delegates to a labkit
`Limiter` instead of its internal counting strategies. The public API doesn't
change. Controllers and services keep calling `.throttled?` as before.

We migrate in cohorts of 5-10 rate limit keys. Each key gets two feature flags:
`_use_labkit_<key>` (shadow mode) and `_<key>_enforce` (enforcement). Shadow
validation needs <0.5% decision divergence over 24 hours before we flip to
enforcement.

- [#28808](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28808) — overarching migration issue with repeatable process
- [#28803](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28803) — Cohort 1 (5 keys: `pipelines_create`, `notes_create`, `search_rate_limit`, `users_get_by_id`, `user_sign_in`)
- [#28809](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28809) — Cohort 2 (remaining IncrementPerAction keys)
- [#28810](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28810) — Cohort 3 (`.peek` callers, blocked on `Limiter#peek` in labkit)
- [#28811](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28811) — Cohort 4 (IncrementPerActionedResource, blocked on Set strategy)
- [#28812](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28812) — Cohort 5 (IncrementResourceUsagePerAction, blocked on float-cost strategy)
- [#28876](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28876) — Feature flag cleanup after rollout
- [#29054](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/29054) — Replace `rate_limits` hash with static labkit Limiter objects

### 1.9 Migration: RackAttack (Stage 2b)

A new middleware runs alongside the existing RackAttack middleware. RackAttack
keeps enforcing. The new middleware runs in parallel, starting in log mode.

Two limiters:

1. **`rack_request`** — all general throttles (API, web, git, packages). Authenticated vs unauthenticated is handled within rules via the `<anonymous>` sentinel and different characteristics (`[:ip]` vs `[:user]`).
2. **`rack_request_protected_paths`** — protected-path throttles only. These overlap with general throttles (a POST to a protected API path fires both), so they need independent counters via a separate limiter.

Two limiters instead of four because:

- The auth/unauth distinction is a characteristic (what you count by), not a limiter boundary
- Git throttles are mutually exclusive with API/web throttles
- Fewer feature flags (4 instead of 8)
- Generic limiters with rich identifiers make it easy to inject external configuration later ([#28853](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28853))

Tracked in [#28852](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28852).

### 1.10 Observability

**Prometheus metrics** — counter metrics are split across two granularities to
cover non-terminating rule chains:

| Metric                                              | Type           | Labels                                                 | Purpose                                                                          |
| --------------------------------------------------- | -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `gitlab_labkit_rate_limiter_calls_total`            | Counter        | `rate_limiter`, `result`                               | One increment per `check` call. Low cardinality; overall rate limiting health.   |
| `gitlab_labkit_rate_limiter_rule_evaluations_total` | Counter        | `rate_limiter`, `rule`, `action`, `result`, `exceeded` | One increment per rule evaluated. Captures every rule in non-terminating chains. |
| `gitlab_labkit_rate_limiter_errors_total`           | Counter        | `rate_limiter`                                         | Redis failure counter (fail-open observability).                                 |
| `gitlab_labkit_rate_limiter_limit`                  | Gauge (`:max`) | `rate_limiter`, `rule`                                 | Configured threshold.                                                            |
| `gitlab_labkit_rate_limiter_period_seconds`         | Gauge (`:max`) | `rate_limiter`, `rule`                                 | Configured period.                                                               |

> **Implementation note:** The current labkit implementation only emits `gitlab_labkit_rate_limiter_calls_total` (with labels `rate_limiter`, `rule`, `action`), plus `errors_total` and the two gauges (implemented in [#28798](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28798)). The split into per-limiter and per-rule-evaluation metrics ships together with the action model refinement ([#29052](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/29052)) as a coordinated breaking change.

**Additional observability work:**

- [#28799](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28799) — Include rate limit state in existing per-request log messages
- [#28831](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28831) — Update Rate Limiting Overview dashboard
- [#28832](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28832) — Register in metrics catalog for default SLI alerts
- [#28807](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28807) — Redis cluster headroom investigation for migration
- [#28827](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28827) — Consolidate Redis operations into a single Lua EVAL call

### 1.11 Cost-aware rate limiting

A `GET /api/v4/user` and a complex GraphQL query are not the same thing, but a
simple request counter treats them equally. The `cost:` parameter on `check`
lets you count by actual resource consumption instead:

```ruby
result = limiter.check(identifier)                         # default cost: 1
result = limiter.check(identifier, cost: db_duration_s)    # cost = actual DB time
```

A rack middleware could use this to limit database time per root namespace.
After each request completes, charge whatever it actually cost:

```ruby
limiter = RESOURCE_LIMITERS[:db_utilization]
result = limiter.check(
  { root_namespace: request.root_namespace, user: request.user },
  cost: request.db_duration_s
)
```

With rules like:

```ruby
Rule.new(
  name: "db_seconds_per_namespace",
  characteristics: [:root_namespace],
  limit: 300,      # 300 seconds of DB time per period
  period_s: 60,
  action: :limit
)
```

The characteristic picks the scope (per user, per project, per namespace). The
cost picks what you're measuring. The same pattern applies to gitaly call
duration, object storage bytes, or sidekiq job weight.

When the cost isn't known before doing the work, `peek` first:

```ruby
result = limiter.peek(identifier)
if result.action == :block
  return error("rate limited, retry after #{result.reset_at}")
end

cost = do_expensive_work

limiter.check(identifier, cost: cost)
```

This can let one extra operation through (peek said "ok", but the cost turned
out to be more than expected). The next request after that will be blocked.

Under the hood, `cost:` uses `INCRBYFLOAT` in the Lua EVAL
([#28827](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28827)).
`INCRBYFLOAT` with `1` behaves the same as `INCR`, so there is no separate
counting strategy for integer vs float costs.

## Phase 2: Externalized Configuration

Labkit loads configuration that overrides the application-provided defaults.
The format follows the [LabKit Configuration Management](../labkit_configuration/)
design document: a protobuf schema defines the structure, with YAML as the
serialization format. Because the schema is shared, the same files load the same
way in `labkit-ruby`, `labkit-go`, and the services that consume them.

_Unlocks:_ adding and changing rules through configuration. A rule change rolls
out without a full build and deploy of the application.

### 2.1 Two kinds of configuration

There are two configuration documents:

1. **Available limiters** is the contract, owned by operators (Production
   Engineering). It lists which rate limiters exist, which identifier properties
   you can match and count on, and the default rule each limiter ships with.
   Application developers contribute to it: they declare the limiters their code
   exposes and propose the defaults, but the contract is reviewed and owned on
   the operator side. It ships with the application and other tooling can read
   it.
2. **Rate limits** holds the rules that override or add to the defaults. It can
   change without an application release.

Labkit validates the rate-limits document against the available-limiters
document: a rule can only match or count on properties the application actually
exposes, and can only target limiters that exist.

The rate-limits document is written at two levels. Operators set global
rules: defaults that apply across all requests, and platform-wide protections. These default rules are defined for limiters that are shared across applications (Rack middlewares, gRPC interceptors, ...).

Service owners add rules scoped to limiters, to raise or lower the
limits for the service they are on-call for. Teams have the freedom to manage
the limits for their own service. Infrastructure gives input when a change has
cross-cutting impact, such as added pressure on shared Redis or on downstream
services.

One thing teams cannot do freely is bypass a limiter. The framework allows a
`skip` rule because Phase 1 has to keep the existing bypasses working, but a
bypass affects more than the team that adds it. We will guardrail who can add
`skip` rules so they cannot be introduced unchecked. What the guardrail looks
like (review, an allowlist, a validation step) is a decision for implementation
time.

### 2.2 Available limiters

This document declares what each limiter enforces, when, what its default rule
is, and whether any of its values come from the database. Database-backed values
can be tied to a characteristic (a per-plan limit) or be an instance-wide global.

```yaml
# available_limiters.yaml — shipped with the application
available_limiters:
  pipelines_create:
    description: "Rate limit enforced before a pipeline is allowed to be created"
    available_properties: # values the identifier can carry, usable in match/characteristics
      - project_path
      - username
      - root_namespace_path
      - root_namespace_plan
      - sha
    default_rule: # optional: documents the in-application default
      characteristics: [username, project_path, sha]
      limit: 10
      period_s: 60
      action: limit
    has_database_configuration: true
  user_sign_in:
    description: "Enforced before a session is created for a specific user"
    available_properties:
      - ip
      - username
    default_rule:
      characteristics: [username]
      limit: 5
      period_s: 600
      action: limit
```

The `default_rule` documents what the application enforces by default. Its
schema is a subset of the fields in a rate-limit rule (below), and its `match`
is always empty (`{}`), because a default applies to every request the limiter
sees. `has_database_configuration: true` signals that the default's
`limit`/`period_s` resolve from the database at check time (the callables from
[1.7](#17-configuration-passthrough)).

When we implement generic limiters in Labkit, the default configuration for these can live in the copier template, so when we change them we ship a
[copier migration](https://copier.readthedocs.io) that updates every consuming
service on its next `copier update`. A new shared limiter, such as one in a Rack
middleware or a gRPC interceptor, gets its defaults from the template instead of
each service writing its own, and later changes to those defaults roll out the
same way. The `rate_limits` file is generated from the template too.

Here is the matching proto. The validation rules live in the schema, but I have
only added a couple here so the example stays readable. These `.proto` files would live in [`labkit-spec`](https://gitlab.com/gitlab-org/quality/tooling/labkit-spec/).

```proto
edition = "2026";
package gitlab.ratelimit.config.v1;

import "buf/validate/validate.proto";

message AvailableLimiters {
  map<string, LimiterSpec> available_limiters = 1
    [(buf.validate.field).map.min_pairs = 1];
}

message LimiterSpec {
  string description = 1 [(buf.validate.field).string.min_len = 1];
  repeated string available_properties = 2;
  DefaultRule default_rule = 3;          // optional
  bool has_database_configuration = 4;
}

message DefaultRule {
  repeated string characteristics = 1;
  uint32 limit = 2;
  uint32 period_s = 3;                   // seconds
  Action action = 4;
}

enum Action {
  ACTION_UNSPECIFIED = 0;
  ACTION_LIMIT = 1;
  ACTION_LOG = 2;
  ACTION_SKIP = 3;
}
```

### 2.3 Rate limits

This is where operators and service owners configure the rules. Each rule names
the limiter it applies to, a `match` that selects which requests it covers, and
the action to take.

```yaml
# rate_limits.yaml — global rules from operators, service-scoped rules from service owners
rate_limits:
  pipelines_create:
    - description: "pipelines per project per 10 minutes for free users"
      limit: 100
      period_s: 600
      action: limit
      characteristics: [project_path]
      match:
        root_namespace_plan: free
    - description: "pipelines per project per 10 minutes for ultimate users"
      limit: 1000
      period_s: 600
      action: limit
      characteristics: [project_path]
      match:
        root_namespace_plan: ultimate
    - description: "limit pipelines a single user can create per hour"
      limit: 60
      period_s: 3600
      action: limit
      characteristics: [username]
      match: {}
    - description: "skip any application-defined rules"
      action: skip
      match: {}
  user_sign_in:
    - description: "distinct users attempting to sign in from a single IP"
      limit: 10
      period_s: 3600
      characteristics: [ip]
      count_distinct: username
      match: {}
```

The rules in the file are evaluated **before** the rules the application
provides. Combined with a trailing terminating `skip` rule (which matches
everything via `match: {}`), this lets the file become the single source of
truth for a limiter: any request that reaches the `skip` bypasses the
application defaults entirely. In Phase 3, rules returned by the external
service come before the file's rules.

Which fields are required depends on the `action`: a `limit`/`log` rule needs
`limit` and `period_s`, a `skip` rule needs neither. One CEL constraint in the
proto enforces that:

```proto
message RateLimits {
  map<string, RuleList> rate_limits = 1;
}

message RuleList {
  repeated Rule rules = 1;
}

message Rule {
  string description = 1;
  Action action = 2 [(buf.validate.field).required = true];
  repeated string characteristics = 3;
  map<string, MatchValue> match = 4;     // equality or { regex: "..." } markers
  optional uint32 limit = 5;
  optional uint32 period_s = 6;          // seconds
  string count_distinct = 7;             // count unique values of this property

  // limit and period_s are required unless the rule only skips (ACTION_SKIP = 3).
  option (buf.validate.message).cel = {
    id: "limit_requires_threshold"
    message: "limit and log rules require limit and period_s"
    expression: "this.action == 3 || (has(this.limit) && has(this.period_s))"
  };
}
```

`match` values use the same explicit type markers as the labkit `Matcher`
object, so equality and regex matching round-trip across YAML and both SDKs:

```yaml
match:
  root_namespace_plan: free # equality
  path:
    regex: "^/api/v\\d+/projects" # regex
```

When `rate_limits.yaml` above is loaded, the per-plan `pipelines_create` rules
are evaluated before the application's default rule. Free-plan projects get
100/10min, Ultimate 1000/10min; the trailing `skip` ensures the application
default never applies once the file is present.

### 2.4 Redis-backed rules (web-UI configuration)

Some self-managed admins want to keep editing rate limits from the admin
web-UI rather than from a file on disk. We can support that without putting the
database back on the hot path: store the UI-managed rules in Redis, using the
same rule schema from [2.3](#23-rate-limits).

The UI writes; labkit reads. When an admin saves a rule, it is serialized into a
per-limiter Redis key (the same Redis instance labkit already uses for
counters). Labkit loads a limiter's rules from Redis the first time that limiter
is hit, then caches them in memory for a short while. It does not read Redis on
every request, and it does not only read at boot. When the cache expires, the
next request through that limiter reloads from Redis, so an admin's change is
picked up within roughly the cache duration. The exact duration is an
implementation detail to settle when we build this.

These rules replace the application defaults rather than layering on top of
them. If Redis has rules for a limiter, labkit uses them; if it has none, the
application's built-in defaults apply. Every limiter stays configurable from the
app, and the defaults are the fallback when nothing is configured.

This is a local version of the Phase 3 external service: the same "return the
rules for this request" idea, backed by a Redis key instead of a remote service.
We want to offer it to self-managed, but it does not block Phase 3 and the two
can ship independently.

**Migrating off the database.** A migration reads the existing
`ApplicationSettings` throttle values, converts each one into a `Rule` object,
and writes it into the Redis store keyed per limiter. Once a limiter's values
live in Redis, the call-site callables from
[1.7](#17-configuration-passthrough) that read `ApplicationSettings` can be
retired for that limiter.

### 2.5 Precedence model

Multiple configuration sources, evaluated in order:

1. **Config-file rules** — loaded by labkit from the YAML file
2. **Redis-backed rules** — written by the admin web-UI (self-managed)
3. **Application defaults** — shipped with the application as a fallback

```plaintext
┌─────────────────────────────────┐
│ Config file rules (highest)     │  ← Loaded by labkit from YAML
├─────────────────────────────────┤
│ Redis-backed rules (web-UI)     │  ← Written by the admin UI
├─────────────────────────────────┤
│ Application defaults (fallback) │  ← Shipped with the application
└─────────────────────────────────┘
```

This means:

- GitLab.com can have platform-level rules (from the config file) that override application defaults
- Self-managed admins can manage rules from the web-UI; those rules replace the application defaults for the limiters they cover
- Self-managed installations that configure neither a file nor Redis rules fall back to the application defaults, so behavior is unchanged
- A platform rule matching a request wins over the default, enabling per-customer or per-tier overrides without code changes
- A more specific service-owner rule is ordered before the operators' global rules, so a team can tune the limits for its own service without touching the global defaults
- A `skip` rule lets the higher tiers bypass the lower ones, which is why adding one is guardrailed (see [2.1](#21-two-kinds-of-configuration))

### 2.6 Deployment

- **Self-managed:** Config file is optional. If absent, existing behavior is unchanged. Admins can provide a config file for custom rate limits, or manage rules from the web-UI (stored in Redis).
- **GitLab.com:** Config file deployed via Helm chart or ops configuration. Platform-level rules managed by Production Engineering.
- **Dedicated:** Config file managed by the Dedicated operator. Per-tenant customization technically possible through the file, but discouraged.
- **Cells:** Per-cell configuration possible through separate config files.

## Phase 3: Dynamic External Service

An external service provides rate limit rules dynamically, based on the request
identifier. This is how we get per-customer, per-tier, and per-namespace
customization without maintaining static configuration files for each case.

_Unlocks:_ different rules for different customers, and near-instant rollout of
a change without a deployment.

### 3.1 Service design

The service receives the identifier from Phase 1 and returns rules for that
request. These take precedence over the config file, the Redis-backed rules, and
the application defaults:

```plaintext
┌─────────────────────────────────────┐
│ External service rules (highest)    │  ← Dynamic, per-request
├─────────────────────────────────────┤
│ Config file rules                   │  ← Static, loaded at startup
├─────────────────────────────────────┤
│ Redis-backed rules (web-UI)         │  ← Written by the admin UI
├─────────────────────────────────────┤
│ Application defaults (fallback)     │  ← Shipped with the application
└─────────────────────────────────────┘
```

The service receives the rate limiter name and the identifier. Between them,
these carry everything the service needs to make a decision: the rate limiting
checkpoint, request type, user, namespace, plan, endpoint.

Because the service keys on the limiter name, it has to account for the same
name meaning different things in different services. This matters most for the
generic limiters (Rack middleware, gRPC interceptors), where `rack_request` is
reused everywhere on purpose. The service scopes rules by the calling service as
well as the limiter name, so a dynamic rule meant for one service does not leak
into another that happens to share the name.

### 3.2 Capabilities

Per-namespace and per-plan thresholds are already possible in Phase 2 through
the config file (rules matching on `namespace_plan` or `root_namespace`). The
external service adds capabilities that static configuration can't provide:

- Dynamic adjustment based on current load or abuse patterns
- Per-customer limits tied to contracts or entitlements managed outside GitLab
- Rules that change without redeploying the config file
- Configurable through terraform, keeping application rate limits in the same repository as Cloudflare and other edge rules

### 3.3 Fail-open and caching

If the service is unreachable, labkit falls back down the same precedence stack:
config file rules, then Redis-backed rules, then the application defaults
(fail-open). Caching (per-identifier, per-namespace, per-plan) reduces the
per-request overhead.

Because rules are cached in memory, a change propagates within the cache
duration rather than the moment it is made. That duration is the practical limit
on how fast a new rule rolls out: minutes, not hours. The exact value is a
tuning decision for implementation time.

### 3.4 Relationship to GATE

The identifier is extensible. [GATE](../new_auth_stack/) introduces `workload_identity` and
`ambient_credential` identity types, which are just new keys in the identifier.
The external service can use them without changes to labkit itself.

## Key Design Decisions

| Decision                                                                            | Rationale                                                                                                                                                                     | Reference                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Rule evaluation with non-terminating `:log`                                         | Shadow-testing new thresholds without disrupting enforcement                                                                                                                  | [#28890](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28890) |
| Action model: `limit`/`log`/`skip`                                                  | Clean separation of enforcement, observability, and bypass semantics                                                                                                          | [#29052](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/29052) |
| Result `action` is the outcome; caller handles it                                   | Labkit is a library, not a framework — callers decide how to respond                                                                                                          | —                                                                                          |
| `<anonymous>` sentinel for unauthenticated requests                                 | Avoid angle-bracket-free sentinel colliding with real usernames; enables rule-level auth/unauth distinction                                                                   | [#28852](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28852) |
| TTL-based fixed windows (vs. divmod clock-aligned)                                  | Pending decision — TTL is simpler and avoids boundary-burst, divmod matches current ApplicationRateLimiter                                                                    | [#28830](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28830) |
| Redis pool `.with` interface                                                        | Proper connection pool usage under Puma multi-threaded workers                                                                                                                | —                                                                                          |
| 2 limiters for RackAttack (not 4)                                                   | Auth/unauth is a characteristic, not a limiter boundary; fewer flags; future-proof for external config                                                                        | [#28852](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28852) |
| Lua EVAL for Redis operations                                                       | Single round-trip for INCR + EXPIRE + TTL; atomic; less Ruby overhead                                                                                                         | [#28827](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28827) |
| Matcher object for pattern matching                                                 | YAML-compatible (explicit `{ regex: "..." }` type markers); cross-language                                                                                                    | [#28855](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28855) |
| Static Limiter objects replacing `rate_limits` hash                                 | Single source of truth; callables for DB-backed values; no per-request allocation                                                                                             | [#29054](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/29054) |
| Prometheus gauge multiprocess mode `:max`                                           | Avoids N duplicate copies under Puma workers; all workers set the same configured value                                                                                       | [#28798](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28798) |
| Configuration evolution: callables → config file → external service                 | Backwards-compatible migration path; no breaking changes for self-managed at any phase                                                                                        | [#28853](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28853) |
| Web-UI rules stored in Redis, not the database                                      | Keeps click-ops for self-managed while taking the database off the hot path; reuses the Redis instance already used for counters; replaces app defaults with a Redis fallback | —                                                                                          |
| Operators own the contract and global rules; service owners tune their own limiters | Teams get autonomy to manage limits for the services they are on-call for, with infrastructure input on cross-cutting changes; bypasses stay guardrailed                      | —                                                                                          |

## References

### Design documents

- [Next Rate Limiting Architecture](../rate_limiting/) — the original 2022 blueprint for a framework to define and enforce limits
- [Simplifying Rate Limiting Configuration](../rate_limiting_simplification/) — the phased roadmap (Phase 1: edge network, Phase 2: application, Phase 3: interface)
- [LabKit Configuration Management](../labkit_configuration/) — protobuf-first configuration schema for labkit services

### External references

- [Cloudflare rate limiting rules — supported actions](https://developers.cloudflare.com/ruleset-engine/rules-language/actions/#supported-actions) — inspiration for the action semantics model

### Tracking

- [Phase 2 epic](https://gitlab.com/groups/gitlab-com/gl-infra/-/work_items/2021) — the parent epic for all implementation work
- [Configuration evolution](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/28853) — design discussion for callables, precedence, and static config
