-- Row-level security: helper functions, FORCE RLS, policies and grants.
--
-- Hand-written rather than generated. Drizzle cannot express FORCE ROW LEVEL
-- SECURITY, SECURITY DEFINER ownership or grant hygiene, and this is the file
-- where a mistake becomes a cross-tenant data leak, so it is written to be read.
--
-- Runs as clientatlas_migration, which is not a superuser and does not hold
-- BYPASSRLS. That matters: FORCE ROW LEVEL SECURITY has no effect on superusers.

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

-- To *own* an object in a schema, a role needs CREATE on that schema. Without
-- this, the ALTER FUNCTION ... OWNER TO statements below fail with
-- "permission denied for schema app".
GRANT USAGE, CREATE ON SCHEMA app TO clientatlas_rls;
--> statement-breakpoint

-- ===========================================================================
-- Claim accessors
-- ===========================================================================

-- The subject of the verified JWT, as set transaction-locally by the
-- application's claims helper.
--
-- Returns NULL when no claims are set, which makes every policy below evaluate
-- to false. A statement issued outside the claims helper therefore sees nothing
-- rather than everything.
--
-- Malformed claims raise instead of returning NULL. That is deliberate: garbage
-- in this setting means the request path is broken, and a hard error is a far
-- better outcome than a NULL that merely looks like "not signed in".
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid;
$$;
--> statement-breakpoint

-- ===========================================================================
-- Membership helpers
-- ===========================================================================
--
-- These three are SECURITY DEFINER and owned by clientatlas_rls, which holds
-- BYPASSRLS. They exist because a policy on organization_members that reads
-- organization_members re-enters itself, and PostgreSQL rejects the recursion.
--
-- Each answers a single boolean question. They take no free-form input, return
-- no rows, and cannot be composed into a way of reading another tenant's data.
-- `search_path` is pinned to empty and every reference is schema-qualified, so
-- no object can be shadowed by a caller.

CREATE OR REPLACE FUNCTION app.is_org_member(org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = org_id
      AND m.user_id = app.current_user_id()
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.has_org_role(org_id uuid, allowed public.organization_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = org_id
      AND m.user_id = app.current_user_id()
      AND m.role = ANY (allowed)
  );
$$;
--> statement-breakpoint

-- Used only to permit the first membership row of a brand-new organization.
-- Without it there is no way to become the owner of an organization you just
-- created, because the "is an owner or admin" check has nothing to match.
CREATE OR REPLACE FUNCTION app.org_has_members(org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = org_id
  );
$$;
--> statement-breakpoint

ALTER FUNCTION app.is_org_member(uuid) OWNER TO clientatlas_rls;
--> statement-breakpoint
ALTER FUNCTION app.has_org_role(uuid, public.organization_role[]) OWNER TO clientatlas_rls;
--> statement-breakpoint
ALTER FUNCTION app.org_has_members(uuid) OWNER TO clientatlas_rls;
--> statement-breakpoint

-- EXECUTE on a new function is granted to PUBLIC by default. Revoke first, then
-- grant narrowly.
REVOKE ALL ON FUNCTION app.is_org_member(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.has_org_role(uuid, public.organization_role[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.org_has_members(uuid) FROM PUBLIC;
--> statement-breakpoint

-- BYPASSRLS exempts a role from policies; it does not grant table privileges.
-- The helper functions run as clientatlas_rls, so that role needs SELECT on the
-- single table they read — and on nothing else. Widening this grant is how the
-- capability boundary would quietly stop being a boundary.
GRANT SELECT ON public.organization_members TO clientatlas_rls;
--> statement-breakpoint

GRANT USAGE ON SCHEMA app TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_user_id() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_org_member(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.has_org_role(uuid, public.organization_role[]) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.org_has_members(uuid) TO authenticated;
--> statement-breakpoint

-- ===========================================================================
-- Enable and FORCE row-level security
-- ===========================================================================
--
-- ENABLE alone still exempts the table owner, and migrations run as the owner.
-- FORCE closes that gap. Both are asserted by the integration tests, because a
-- table added later without them would be invisible to review but wide open.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.organization_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ===========================================================================
-- Grants
-- ===========================================================================
--
-- RLS filters rows; it does not grant access to a table. Both are required.
-- Nothing is granted to PUBLIC, and no DELETE is granted on profiles.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspaces TO authenticated;
--> statement-breakpoint

-- Integration-test fixture role.
--
-- BYPASSRLS lets it ignore policies; it still needs table privileges, and
-- TRUNCATE ... CASCADE requires the privilege on every table the cascade
-- reaches. It exists so the harness can seed the `profiles` rows Supabase
-- creates at signup, and reset state between runs. The application never
-- connects as this role, and `credential and schema posture` asserts as much.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.profiles TO clientatlas_test;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.organizations TO clientatlas_test;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.organization_members TO clientatlas_test;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.workspaces TO clientatlas_test;
--> statement-breakpoint

-- ===========================================================================
-- profiles
-- ===========================================================================
--
-- A user sees and edits their own row. Co-member visibility is deliberately not
-- granted: nothing in the product needs it yet, and the narrower policy is the
-- one that is easy to widen later under review.

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING (id = app.current_user_id());
--> statement-breakpoint

CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = app.current_user_id());
--> statement-breakpoint

-- USING selects which rows may be updated; WITH CHECK constrains the result.
-- Both are needed — USING alone would let a user rewrite their own row's id.
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = app.current_user_id())
  WITH CHECK (id = app.current_user_id());
--> statement-breakpoint

-- ===========================================================================
-- organizations
-- ===========================================================================

CREATE POLICY organizations_select_member ON public.organizations
  FOR SELECT TO authenticated
  USING (app.is_org_member(id));
--> statement-breakpoint

-- Any authenticated user may create an organization. They are not a member of
-- it yet, so the SELECT policy does not pass and `INSERT ... RETURNING` would
-- fail. The application therefore generates the id client-side and inserts the
-- organization and its first membership row in one transaction.
CREATE POLICY organizations_insert_any ON public.organizations
  FOR INSERT TO authenticated
  WITH CHECK (true);
--> statement-breakpoint

CREATE POLICY organizations_update_admin ON public.organizations
  FOR UPDATE TO authenticated
  USING (app.has_org_role(id, ARRAY['owner', 'admin']::public.organization_role[]))
  WITH CHECK (app.has_org_role(id, ARRAY['owner', 'admin']::public.organization_role[]));
--> statement-breakpoint

CREATE POLICY organizations_delete_owner ON public.organizations
  FOR DELETE TO authenticated
  USING (app.has_org_role(id, ARRAY['owner']::public.organization_role[]));
--> statement-breakpoint

-- ===========================================================================
-- organization_members
-- ===========================================================================

CREATE POLICY organization_members_select_member ON public.organization_members
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

-- Two legitimate paths in: an owner or admin adds somebody, or the creator of a
-- brand-new organization claims it. The second is restricted to adding
-- *yourself* as *owner* of an organization that has no members at all, so it
-- cannot be used to join someone else's organization.
CREATE POLICY organization_members_insert ON public.organization_members
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[])
    OR (
      user_id = app.current_user_id()
      AND role = 'owner'
      AND NOT app.org_has_members(organization_id)
    )
  );
--> statement-breakpoint

CREATE POLICY organization_members_update_admin ON public.organization_members
  FOR UPDATE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]))
  WITH CHECK (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
--> statement-breakpoint

CREATE POLICY organization_members_delete_admin ON public.organization_members
  FOR DELETE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
--> statement-breakpoint

-- ===========================================================================
-- workspaces
-- ===========================================================================

CREATE POLICY workspaces_select_member ON public.workspaces
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

CREATE POLICY workspaces_insert_editor ON public.workspaces
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

-- WITH CHECK repeats the organization check so a workspace cannot be moved into
-- another tenant by updating organization_id.
CREATE POLICY workspaces_update_editor ON public.workspaces
  FOR UPDATE TO authenticated
  USING (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  )
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

CREATE POLICY workspaces_delete_admin ON public.workspaces
  FOR DELETE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
