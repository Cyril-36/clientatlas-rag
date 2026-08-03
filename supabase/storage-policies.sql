-- Storage bucket and row-level security for object access.
--
-- `storage.objects` is owned by supabase_storage_admin, and on a local stack
-- `postgres` is neither its owner nor a member of that role — so policies here
-- must be created by `supabase_admin`, the only superuser present:
--
--   docker exec -i supabase_db_clientatlas psql -U supabase_admin -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/storage-policies.sql
--
-- On a hosted project the dashboard SQL editor has the necessary privileges, so
-- the same file can be pasted there unchanged. `pnpm run db:setup` does the
-- local version in the right order.
--
-- Idempotent and safe to re-run.
--
-- ORDERING: this runs *after* the Drizzle migrations, because every policy here
-- calls app.is_org_member / app.has_org_role / app.storage_org_id, which those
-- migrations create. `pnpm run db:setup` runs both in the right order.
--
-- The Storage service authenticates the caller's JWT and sets
-- `request.jwt.claims` before touching this table, which is the same mechanism
-- the application's claims helper uses. The membership helpers therefore work
-- unchanged, and object access is governed by exactly the same notion of
-- membership as row access. There is one definition of "belongs to this
-- tenant", not two that can drift apart.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  -- Private. Every read goes through a policy or a short-lived signed URL;
  -- there is no public object URL for tenant content.
  false,
  26214400, -- 25 MB, matching DEFAULT_MAX_FILE_BYTES in the application
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clientatlas_documents_select ON storage.objects;
DROP POLICY IF EXISTS clientatlas_documents_insert ON storage.objects;
DROP POLICY IF EXISTS clientatlas_documents_delete ON storage.objects;

-- Read. Any member of the owning organisation may download.
CREATE POLICY clientatlas_documents_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND app.is_org_member(app.storage_org_id(name))
  );

-- Write. Editors and above, and only into their own organisation's prefix.
CREATE POLICY clientatlas_documents_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND app.has_org_role(
      app.storage_org_id(name),
      ARRAY['owner', 'admin', 'editor']::public.organization_role[]
    )
  );

-- There is deliberately NO UPDATE policy.
--
-- Objects are immutable, matching document_versions: re-uploading a document
-- creates a new version at a new path. Without this, "the bytes behind this
-- citation changed" would be a reachable state, and a stored answer could cite
-- a page that no longer says what it said.

CREATE POLICY clientatlas_documents_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND app.has_org_role(
      app.storage_org_id(name),
      ARRAY['owner', 'admin']::public.organization_role[]
    )
  );
