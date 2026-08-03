-- Row-level security for documents and document versions.
--
-- Same shape as 0001: enable, force, grant narrowly, then policy per command.
-- The one departure is document_versions, which is immutable — the absence of
-- an UPDATE policy is backed by the absence of an UPDATE grant, so an attempt
-- fails on privileges before a policy is even consulted.

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.document_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
--> statement-breakpoint

-- No UPDATE. A document version records bytes that already exist; changing one
-- would mean the text behind an existing citation could silently change.
GRANT SELECT, INSERT, DELETE ON public.document_versions TO authenticated;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.documents TO clientatlas_test;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.document_versions TO clientatlas_test;
--> statement-breakpoint

-- ===========================================================================
-- documents
-- ===========================================================================

CREATE POLICY documents_select_member ON public.documents
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

CREATE POLICY documents_insert_editor ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

-- WITH CHECK repeats the check on the *new* row, so a document cannot be moved
-- into another organisation by updating organization_id. The composite foreign
-- key to (workspace_id, organization_id) already makes a cross-tenant workspace
-- structurally impossible; this closes the same door from the policy side, and
-- neither is relied on alone.
CREATE POLICY documents_update_editor ON public.documents
  FOR UPDATE TO authenticated
  USING (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  )
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

CREATE POLICY documents_delete_admin ON public.documents
  FOR DELETE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
--> statement-breakpoint

-- ===========================================================================
-- document_versions
-- ===========================================================================

CREATE POLICY document_versions_select_member ON public.document_versions
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

CREATE POLICY document_versions_insert_editor ON public.document_versions
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

CREATE POLICY document_versions_delete_admin ON public.document_versions
  FOR DELETE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
