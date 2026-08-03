-- Extract the owning organisation from a storage object path.
--
-- Storage objects live at:
--
--   organizations/{organization_id}/workspaces/{workspace_id}/documents/{document_id}/{version_id}.pdf
--
-- The Storage service stores that whole path as a single text column, so the
-- policies that guard `storage.objects` have to recover the tenant from it.
-- This function is the only place that parsing happens.
--
-- It returns NULL rather than raising for anything that does not match the
-- convention exactly. A policy comparing against NULL evaluates to false, so a
-- malformed or hand-crafted path — `../`, a missing segment, a non-UUID where
-- the organisation should be — is denied rather than erroring, and cannot be
-- used to probe for the existence of other objects through error messages.
--
-- Deliberately built from `split_part` rather than `storage.foldername`: this
-- migration runs as clientatlas_migration, which has no business holding
-- privileges on the storage schema, and pure string functions need none.

CREATE OR REPLACE FUNCTION app.storage_org_id(object_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN object_name IS NULL THEN NULL
    -- The literal prefix has to be present, so a path that merely happens to
    -- start with a UUID cannot pass.
    WHEN split_part(object_name, '/', 1) <> 'organizations' THEN NULL
    WHEN split_part(object_name, '/', 3) <> 'workspaces' THEN NULL
    WHEN split_part(object_name, '/', 5) <> 'documents' THEN NULL
    -- Reject anything that is not exactly a UUID before casting, so the cast
    -- cannot raise.
    WHEN split_part(object_name, '/', 2) !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL
    ELSE split_part(object_name, '/', 2)::uuid
  END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.storage_org_id(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.storage_org_id(text) TO authenticated;
