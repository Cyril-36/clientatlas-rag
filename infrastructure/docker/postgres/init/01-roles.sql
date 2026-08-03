-- Database roles.
--
-- Runs once, as the bootstrap superuser, when the data volume is first created.
--
-- The most important property established here is that clientatlas_migration is
-- NOT a superuser. FORCE ROW LEVEL SECURITY does not apply to superusers or to
-- roles holding BYPASSRLS. If migrations ran as the bootstrap superuser, the
-- table owner would silently read every tenant's rows, and the cross-tenant test
-- suite would be asserting nothing while appearing to pass.
--
-- The passwords below are local-development only. They exist so that
-- `docker compose up` works with no manual step. Nothing that reaches a network
-- other than this machine's loopback interface may use them.
--
-- On hosted Supabase the equivalent of this file is run once in the SQL editor;
-- `authenticated` already exists there, so those statements become no-ops.

-- ---------------------------------------------------------------------------
-- authenticated — the role every user-facing statement executes as.
--
-- NOLOGIN: it is never connected to directly. A request arrives on a
-- clientatlas_runtime connection and switches into this role for the duration
-- of one transaction.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_migration — owns the schema and runs migrations.
--
-- Deliberately not a superuser and without BYPASSRLS, so that FORCE ROW LEVEL
-- SECURITY constrains the owner too. It never serves a user request.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_migration') THEN
    CREATE ROLE clientatlas_migration LOGIN PASSWORD 'local_migration_only' NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_runtime — the connection the web application opens.
--
-- NOINHERIT is the point: membership of `authenticated` does not passively
-- confer its privileges. The application must explicitly `SET LOCAL ROLE
-- authenticated`, which means a query issued outside the claims helper has no
-- table privileges at all and fails loudly rather than reading unfiltered rows.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_runtime') THEN
    CREATE ROLE clientatlas_runtime LOGIN PASSWORD 'local_runtime_only' NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_worker — ingestion and storage only. Same NOINHERIT discipline.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_worker') THEN
    CREATE ROLE clientatlas_worker LOGIN PASSWORD 'local_worker_only' NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_test — integration-test fixtures only.
--
-- This is the one role that holds BYPASSRLS, and it exists so the test harness
-- can seed the rows that a real deployment creates out of band: `profiles` rows,
-- which Supabase writes from an auth trigger at signup.
--
-- Everything else in the test suite is created through the ordinary policies as
-- `authenticated`, because a fixture that bypasses the policies would prove
-- only that the fixture works. The application must never use this role, and
-- `test_runtime_role_cannot_bypass_rls` asserts the runtime role does not share
-- this attribute.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_test') THEN
    CREATE ROLE clientatlas_test LOGIN PASSWORD 'local_test_only' BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- clientatlas_rls — owns the membership helper functions, and nothing else.
--
-- A policy on organization_members that asks "is the current user a member of
-- this organization?" reads organization_members, which re-enters the same
-- policy. PostgreSQL detects the recursion and errors.
--
-- The escape hatch is a SECURITY DEFINER function whose owner is not subject to
-- the policy. That owner cannot be clientatlas_migration, because FORCE ROW
-- LEVEL SECURITY constrains the table owner too — which is the entire point of
-- using FORCE. So the capability gets its own role, and that role's only
-- purpose is to own three small, fully-qualified, STABLE functions with
-- `search_path` pinned to empty and EXECUTE revoked from PUBLIC.
--
-- NOLOGIN: nothing ever connects as this role. It is a capability boundary, not
-- an account. Widening what it owns is how this design would fail, so anything
-- added here belongs in review.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clientatlas_rls') THEN
    CREATE ROLE clientatlas_rls NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- The migration role must be able to hand ownership of the helper functions
-- over to clientatlas_rls.
GRANT clientatlas_rls TO clientatlas_migration;

-- Membership: runtime and worker may assume `authenticated`, but only by
-- asking for it.
GRANT authenticated TO clientatlas_runtime;
GRANT authenticated TO clientatlas_worker;
GRANT authenticated TO clientatlas_test;

-- The migration role needs to create objects; nobody else does. CREATE on the
-- database itself is required because the migration journal lives in its own
-- `drizzle` schema, which the migrator creates on first run.
DO $$
BEGIN
  EXECUTE format(
    'GRANT CREATE, CONNECT ON DATABASE %I TO clientatlas_migration',
    current_database()
  );
END
$$;

GRANT CREATE, USAGE ON SCHEMA public TO clientatlas_migration;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Existing objects in `public` were created by the bootstrap superuser, so the
-- migration role is given ownership of the schema it will extend.
ALTER SCHEMA public OWNER TO clientatlas_migration;
