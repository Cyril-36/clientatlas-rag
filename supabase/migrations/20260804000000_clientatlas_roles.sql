-- ClientAtlas database roles, for the Supabase platform.
--
-- Runs as `postgres`, which is the only role able to create other roles. This
-- file establishes the separation of duties the application depends on; the
-- tenant schema itself is owned by Drizzle migrations under
-- `packages/database/migrations`, applied as clientatlas_migration.
--
-- NO PASSWORDS ARE SET HERE. Supabase applies `supabase/migrations/*` to hosted
-- projects on deploy, so a password written here would end up in a remote
-- database and in git history. Local development passwords live in
-- `supabase/seed.sql`, which Supabase runs only against a local stack. A hosted
-- project gets its passwords set out of band, once, by a human.
--
-- A LOGIN role with no password cannot authenticate, so the intermediate state
-- this file leaves behind is closed rather than open.

-- ---------------------------------------------------------------------------
-- authenticated
--
-- Supabase already defines this, along with `anon` and `service_role`. The
-- guard is here so the same file also works against a plain PostgreSQL.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_migration — owns the tenant schema and runs its migrations.
--
-- Not a superuser and without BYPASSRLS, because FORCE ROW LEVEL SECURITY has
-- no effect on either. Supabase's `postgres` role is privileged, which is
-- exactly why the tenant tables must not be owned by it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_migration') THEN
    CREATE ROLE clientatlas_migration LOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_runtime — the connection the web application opens.
--
-- NOINHERIT: membership of `authenticated` is granted but not passively held,
-- so the application must explicitly assume it inside the claims helper. A
-- query issued outside the helper therefore has no table privileges at all.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_runtime') THEN
    CREATE ROLE clientatlas_runtime LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_worker') THEN
    CREATE ROLE clientatlas_worker LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_rls — owns the membership helper functions, and nothing else.
--
-- A policy on organization_members that reads organization_members re-enters
-- itself and PostgreSQL rejects the recursion. The escape is a SECURITY DEFINER
-- function whose owner is not subject to the policy — which cannot be the table
-- owner, since FORCE constrains the owner. So the capability gets its own role.
--
-- NOLOGIN: nothing connects as this. It is a capability boundary, not an
-- account, and widening what it owns is how the design would fail.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_rls') THEN
    CREATE ROLE clientatlas_rls NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_test — integration-test fixtures only.
--
-- Holds BYPASSRLS so the harness can seed rows a real deployment creates out of
-- band. The application must never connect as this role. On a hosted project
-- this role should simply be left without a password.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_test') THEN
    CREATE ROLE clientatlas_test LOGIN BYPASSRLS;
  END IF;
END
$$;

-- Membership: runtime and worker may assume `authenticated`, but only by asking.
GRANT authenticated TO clientatlas_runtime;
GRANT authenticated TO clientatlas_worker;
GRANT authenticated TO clientatlas_test;

-- The migration role must be able to hand ownership of the helper functions to
-- clientatlas_rls, which requires membership.
GRANT clientatlas_rls TO clientatlas_migration;

-- Schema and database privileges.
--
-- Unlike the plain-PostgreSQL bootstrap, ownership of `public` is left alone:
-- on Supabase it belongs to the platform, and taking it would be both rude and
-- fragile. CREATE is granted instead. CREATE on the database is needed because
-- the Drizzle migration journal lives in its own `drizzle` schema.
GRANT CREATE, USAGE ON SCHEMA public TO clientatlas_migration;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CREATE, CONNECT ON DATABASE %I TO clientatlas_migration',
    current_database()
  );
END
$$;

-- `profiles.id` mirrors `auth.users.id`, and the foreign key that enforces it is
-- declared by a Drizzle migration running as clientatlas_migration. Declaring a
-- foreign key requires REFERENCES on the parent table.
GRANT USAGE ON SCHEMA auth TO clientatlas_migration;
GRANT REFERENCES, SELECT ON TABLE auth.users TO clientatlas_migration;
