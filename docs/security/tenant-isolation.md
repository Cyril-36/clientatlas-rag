# Tenant isolation

How ClientAtlas keeps one organisation's data away from another, and why the
mechanism is in the database rather than in application code.

## The claim

A defect in a route handler — a missing `where` clause, a wrong parameter, an
unvalidated id from a URL — should produce a broken endpoint, not a cross-tenant
data leak. Application-level filtering cannot make that claim, because the
filter and the bug live in the same place.

## Five properties, and what enforces each

### 1. Policies apply to everyone, including the table owner

`ENABLE ROW LEVEL SECURITY` exempts the table owner. Migrations run as the
owner, so an owner exemption is not theoretical. Every tenant table therefore
also gets `FORCE ROW LEVEL SECURITY`.

`FORCE` has no effect on superusers or on roles holding `BYPASSRLS`. That is why
`clientatlas_migration` is neither. `src/migrate.ts` refuses to run as a
superuser rather than produce a database where the tests pass and prove nothing.

### 2. The request credential cannot read anything on its own

`clientatlas_runtime` is `NOINHERIT`, `NOBYPASSRLS`, owns nothing, and has been
granted no table privileges. Membership of `authenticated` is granted but not
inherited, so it must be assumed explicitly.

The consequence is the useful part: a query issued outside the claims helper
fails with `permission denied`, not with unfiltered rows. The failure mode of
forgetting the helper is a broken endpoint.

### 3. Identity is transaction-local

`withTenantContext` opens a transaction and, in order:

1. writes the verified claims into `request.jwt.claims` with `set_config(..., true)`,
2. runs `set local role authenticated`,
3. executes the caller's queries,
4. commits or rolls back.

Both settings are scoped to the transaction, so nothing survives onto the pooled
connection for the next request that borrows it. Relaxing either `SET LOCAL` to
a plain `SET` would break that, which is what
`does not leak claims between transactions on a pooled connection` exists to
catch.

Claims are written while still connected as `clientatlas_runtime`, before the
role switch, so everything the caller runs is evaluated as `authenticated` with
identity already in place.

### 4. Only verified, narrow claims reach the database

`verifyAccessToken` checks the signature and expiry, then applies two checks
that matter for tenancy:

- `sub` must be a UUID. Every policy casts it to `uuid`; a non-UUID subject
  would raise inside a policy rather than simply matching nothing.
- `role` must be exactly `authenticated`. Supabase also issues `service_role`
  tokens, which bypass row-level security entirely, and one must never be
  accepted on a user request path.

What goes into `request.jwt.claims` is a fixed three-field shape, never the raw
token payload. Passing the payload through would let a token author introduce
arbitrary keys into a security-critical setting.

### 5. The recursion escape hatch is as small as it can be

A policy on `organization_members` that asks "is the caller a member of this
organisation?" reads `organization_members`, re-entering itself. PostgreSQL
rejects the recursion.

The escape is a `SECURITY DEFINER` function whose owner is not subject to the
policy. That owner cannot be the table owner, because `FORCE` constrains the
owner — the whole point of using `FORCE`. So the capability has its own role,
`clientatlas_rls`:

- `NOLOGIN` — nothing connects as it; it is a capability, not an account.
- Owns exactly three functions, each returning a single boolean.
- Granted `SELECT` on `organization_members` and nothing else. `BYPASSRLS`
  exempts a role from policies; it does not grant table privileges, so this
  grant is the real limit on what the role can reach.
- Every function is `STABLE` with `search_path` pinned to empty and all
  references schema-qualified, so no object can be shadowed by a caller.
- `EXECUTE` is revoked from `PUBLIC` and granted only to `authenticated`.

Widening what this role owns or can read is how the design would quietly stop
working. It belongs in review.

## Roles

| Role                    | Login | BYPASSRLS | Purpose                                         |
| ----------------------- | ----- | --------- | ----------------------------------------------- |
| `authenticated`         | no    | no        | Assumed per transaction; policies target it     |
| `clientatlas_migration` | yes   | no        | Owns the schema, runs migrations                |
| `clientatlas_runtime`   | yes   | no        | Serves requests; NOINHERIT, no grants           |
| `clientatlas_worker`    | yes   | no        | Ingestion and storage _(M4)_                    |
| `clientatlas_rls`       | no    | yes       | Owns the three membership helpers, nothing else |
| `clientatlas_test`      | yes   | yes       | Integration fixtures only; never the app        |

## What the tests actually assert

`apps/product-api/tests/integration/tenancy.test.ts`, 24 tests against a real
PostgreSQL. Beyond the obvious cross-tenant read and write attempts:

- **Fixtures go through the policies.** Only `profiles` rows are seeded with the
  `BYPASSRLS` role, because a real deployment creates those from a Supabase auth
  trigger. The organisation, the ownership record and the workspace are all
  created as `authenticated`. A fixture that bypassed the policies would prove
  only that the fixture works.
- **The legitimate case still works.** Isolation is trivially satisfied by
  denying everything, so one test asserts a member can create and read a
  workspace in their own organisation.
- **Rejections are checked for the right reason.** Drizzle wraps driver errors,
  so asserting on the top-level message would pass for _any_ failed query. The
  matcher walks the `cause` chain and requires `row-level security` or
  SQLSTATE 42501.
- **Posture is asserted, not assumed.** Separate tests read `pg_class` and
  `pg_roles` to confirm every table still has RLS enabled _and_ forced, that the
  runtime role still cannot bypass RLS and is still `NOINHERIT`, and that the
  tables are not owned by the role querying them. A table added later without
  `FORCE` fails the suite.

## Known gaps

- A workspace cannot yet be moved between organisations by design, but there is
  no test for an organisation being deleted out from under an active session.
- `profiles` visibility is restricted to the owner. Co-member visibility will be
  needed for member management UI and is deliberately not granted yet.
- Storage policies are M3. Nothing here says anything about object access.
- Supabase Auth issues the tokens this verifies, but the sign-in flow itself is
  not wired up; tokens are currently minted by the test harness.
