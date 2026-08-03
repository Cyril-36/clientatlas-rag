# Deploying to a hosted Supabase project

Deployment is four steps, not one command, and two of them are deliberately
manual. This document explains why, so the manual steps are not "optimised
away" later by someone who assumes they were an oversight.

**Project:** `izrishcepnwfrpracnqa` (ClientAtlas, ap-south-1, Free tier)

## Why it is not one command

The tenant schema does not live in `supabase/migrations`. Two migration sets
exist, and they are separate on purpose:

| Set      | Location                        | Applied as                                    | Contains              |
| -------- | ------------------------------- | --------------------------------------------- | --------------------- |
| Platform | `supabase/migrations/`          | `postgres`, by `supabase db push`             | Roles, extensions     |
| Tenant   | `packages/database/migrations/` | `clientatlas_migration`, by `pnpm db:migrate` | Tables, RLS, policies |

The split exists because the tenant tables must **not** be owned by a
privileged role. `FORCE ROW LEVEL SECURITY` has no effect on a superuser or on
a role holding `BYPASSRLS`, so if the schema were pushed by `supabase db push`
it would be owned by `postgres` and every policy would be advisory. The
migrator refuses to run as a superuser for the same reason.

The roles are also created **without passwords** — `supabase/migrations/` is
applied to hosted projects, so a password written there would be committed to
git and shipped to production. A `LOGIN` role with no password cannot
authenticate, so the state between step 1 and step 2 is closed, not open.

## Preconditions

- The project is not paused. Free-tier projects pause after ~1 week idle, and
  `supabase link` fails against a paused project.
- `supabase login` has been run, and `supabase link --project-ref izrishcepnwfrpracnqa`
  has succeeded.

## Step 1 — push platform migrations

```bash
supabase db push
```

Creates `authenticated`, `clientatlas_migration`, `clientatlas_runtime`,
`clientatlas_worker`, `clientatlas_rls`, `clientatlas_test`, and the `vector`
and `pg_trgm` extensions.

`clientatlas_test` holds `BYPASSRLS` and exists only for integration fixtures.
**Leave it without a password on a hosted project.** Nothing there should be
able to connect as it.

## Step 2 — set role passwords (manual, dashboard SQL editor)

Generate strong distinct passwords and run:

```sql
ALTER ROLE clientatlas_migration WITH PASSWORD '<generated>';
ALTER ROLE clientatlas_runtime   WITH PASSWORD '<generated>';
ALTER ROLE clientatlas_worker    WITH PASSWORD '<generated>';
```

These values go into the deployment's environment only — never into `.env.example`,
never into a migration, never into git. This step is manual because there is no
way to automate it that does not put a production credential somewhere it can be
committed.

## Step 3 — apply the tenant schema

With `MIGRATION_DATABASE_URL` pointing at the remote, using the
`clientatlas_migration` password from step 2:

```bash
MIGRATION_DATABASE_URL='postgresql://clientatlas_migration:<password>@db.izrishcepnwfrpracnqa.supabase.co:5432/postgres' pnpm --filter @clientatlas/database run db:migrate
```

The migrator checks `usesuper` before doing anything and aborts if the
credential is a superuser.

## Step 4 — apply storage policies (manual, dashboard SQL editor)

Paste `supabase/storage-policies.sql`. It is idempotent.

Locally this needs `supabase_admin` because `postgres` is neither the owner of
`storage.objects` nor a member of `supabase_storage_admin`. On a hosted project
the SQL editor has the privileges it needs.

## Step 5 — verify, do not assume

Run these in the SQL editor. All three protect properties that fail _silently_
if they regress.

```sql
-- Every tenant table must be BOTH enabled and forced, and owned by
-- clientatlas_migration. An owner of `postgres` means FORCE is doing nothing.
SELECT c.relname,
       c.relrowsecurity  AS enabled,
       c.relforcerowsecurity AS forced,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;
```

```sql
-- The request credential must not be able to bypass RLS, and must be NOINHERIT
-- so it holds no privileges outside the claims helper.
SELECT rolname, rolsuper, rolbypassrls, rolinherit
FROM pg_roles
WHERE rolname LIKE 'clientatlas%' OR rolname = 'authenticated'
ORDER BY rolname;
```

```sql
-- Storage policies must exist, and there must be NO update policy: objects are
-- immutable so a citation cannot come to point at different bytes.
SELECT policyname, cmd FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;
```

Expected: four tenant tables plus `documents`/`document_versions`, all
`enabled = t` and `forced = t`, all owned by `clientatlas_migration`;
`clientatlas_runtime` with `rolsuper = f`, `rolbypassrls = f`, `rolinherit = f`;
exactly three storage policies (SELECT, INSERT, DELETE).

## Free-tier realities

- **The project pauses after ~1 week of inactivity.** A portfolio link that is
  dead when a recruiter clicks it is worse than no link. Either keep it warm
  with a scheduled request, or lead with a recorded demo and treat the hosted
  deployment as secondary.
- 500 MB database and 1 GB file storage. Fine at demo scale; the synthetic seed
  dataset should be sized with it in mind.
- Compute is `t3a.nano`. Do not benchmark retrieval latency here and present the
  numbers as representative.

## What this runbook does not cover

- Vercel deployment of the Next.js application (M9).
- The demo-mode read-only enforcement and rate limiting (M9).
- Query embedding for the public demo. The AI service is Python and Vercel is
  not, so the hosted demo has no embedder unless one is added — see the
  Transformers.js decision in the project notes.
