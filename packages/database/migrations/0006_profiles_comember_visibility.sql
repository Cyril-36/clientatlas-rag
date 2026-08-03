-- Let members of the same organisation see each other's profiles.
--
-- Until now `profiles` was visible only to its owner, which was the right place
-- to start but makes member management impossible: an owner cannot show a list
-- of who is in their organisation if every row but their own is invisible.
--
-- The widening is bounded by co-membership, not by authentication. A user in
-- another organisation remains completely invisible, which the cross-tenant
-- suite continues to assert.

-- Same recursion problem as `is_org_member`, and the same answer: this reads
-- organization_members from inside a policy that is itself evaluated while
-- reading a table, so it must not be subject to those policies. Owned by
-- clientatlas_rls, search_path pinned, EXECUTE revoked from PUBLIC.
--
-- It answers exactly one question and returns a boolean. It cannot be used to
-- enumerate anybody: the caller must already know the id they are asking about,
-- and a wrong guess returns false.
CREATE OR REPLACE FUNCTION app.shares_org_with(other_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members mine
    JOIN public.organization_members theirs
      ON theirs.organization_id = mine.organization_id
    WHERE mine.user_id = app.current_user_id()
      AND theirs.user_id = other_user
  );
$$;
--> statement-breakpoint

ALTER FUNCTION app.shares_org_with(uuid) OWNER TO clientatlas_rls;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.shares_org_with(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.shares_org_with(uuid) TO authenticated;
--> statement-breakpoint

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
--> statement-breakpoint

CREATE POLICY profiles_select_visible ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = app.current_user_id()
    OR app.shares_org_with(id)
  );
--> statement-breakpoint

-- INSERT and UPDATE stay restricted to the owner. Seeing a colleague is not
-- permission to edit them.
