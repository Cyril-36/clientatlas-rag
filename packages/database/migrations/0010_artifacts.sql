CREATE TYPE "public"."artifact_kind" AS ENUM('readiness_report', 'onboarding_brief', 'faq', 'action_plan');--> statement-breakpoint
CREATE TABLE "artifact_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"chunk_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_title" text NOT NULL,
	"page_number" integer,
	"quote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_evidence_section_ordinal_key" UNIQUE("artifact_version_id","section_key","ordinal")
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"sections" jsonb NOT NULL,
	"authored_by" uuid,
	"generated" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_artifact_number_key" UNIQUE("artifact_id","version_number"),
	CONSTRAINT "artifact_versions_id_org_key" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"title" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_id_org_key" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_version_org_fk" FOREIGN KEY ("artifact_version_id","organization_id") REFERENCES "public"."artifact_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_authored_by_profiles_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_org_fk" FOREIGN KEY ("artifact_id","organization_id") REFERENCES "public"."artifacts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_evidence_version_idx" ON "artifact_evidence" USING btree ("artifact_version_id");--> statement-breakpoint
CREATE INDEX "artifact_versions_artifact_idx" ON "artifact_versions" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifacts_workspace_kind_idx" ON "artifacts" USING btree ("workspace_id","kind");--> statement-breakpoint

-- ===========================================================================
-- Row-level security for the artifact tables.
--
-- Same shape as 0001 and 0003: enable, force, grant narrowly, then a policy per
-- command. Two departures, both deliberate.
--
-- `artifact_versions` and `artifact_evidence` get no UPDATE grant and no UPDATE
-- policy. An artifact version is what a citation points at; if it could be
-- edited in place then every citation ever shown would be a claim about text
-- that may since have changed. Editing appends a new version, which is the same
-- rule `document_versions` follows.
--
-- Evidence is insert-and-delete only for the same reason. Rewriting which
-- passage supported a paragraph, after the paragraph was published, is exactly
-- the operation this table exists to make impossible.
-- ===========================================================================

ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.artifacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.artifact_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.artifact_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.artifact_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.artifact_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.artifacts TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.artifact_versions TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.artifact_evidence TO authenticated;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.artifacts TO clientatlas_test;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.artifact_versions TO clientatlas_test;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.artifact_evidence TO clientatlas_test;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- artifacts
-- ---------------------------------------------------------------------------

CREATE POLICY artifacts_select_member ON public.artifacts
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

CREATE POLICY artifacts_insert_editor ON public.artifacts
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

-- USING and WITH CHECK both. USING alone would let an editor move a row they
-- can see into an organisation they cannot.
CREATE POLICY artifacts_update_editor ON public.artifacts
  FOR UPDATE TO authenticated
  USING (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  )
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

CREATE POLICY artifacts_delete_admin ON public.artifacts
  FOR DELETE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- artifact_versions
-- ---------------------------------------------------------------------------

CREATE POLICY artifact_versions_select_member ON public.artifact_versions
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

CREATE POLICY artifact_versions_insert_editor ON public.artifact_versions
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

CREATE POLICY artifact_versions_delete_admin ON public.artifact_versions
  FOR DELETE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- artifact_evidence
-- ---------------------------------------------------------------------------

CREATE POLICY artifact_evidence_select_member ON public.artifact_evidence
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

CREATE POLICY artifact_evidence_insert_editor ON public.artifact_evidence
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

CREATE POLICY artifact_evidence_delete_admin ON public.artifact_evidence
  FOR DELETE TO authenticated
  USING (app.has_org_role(organization_id, ARRAY['owner', 'admin']::public.organization_role[]));
