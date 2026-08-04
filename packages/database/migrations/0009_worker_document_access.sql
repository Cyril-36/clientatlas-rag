-- The worker's access to documents and their versions.
--
-- 0008 gave the worker policies on ingestion_jobs and document_chunks and said
-- that was all it needed. That was wrong, and it was wrong in the direction
-- that matters: ingestion cannot work without reading which object to fetch and
-- reporting what happened. The worker must read document_versions to learn a
-- storage path, and must move a document between `processing`, `ready` and
-- `failed`.
--
-- Rather than widen it to a general UPDATE, the grant is restricted to the
-- specific columns ingestion writes. Column-level grants are the right tool
-- here and are rarely reached for: the worker can set a document's status, and
-- physically cannot rewrite its title, its workspace, or the organisation that
-- owns it — even through a bug in the worker itself.

GRANT SELECT ON public.documents TO clientatlas_worker;
--> statement-breakpoint
GRANT SELECT ON public.document_versions TO clientatlas_worker;
--> statement-breakpoint

-- Exactly the columns ingestion owns, and nothing else.
GRANT UPDATE (status, failure_code, updated_at) ON public.documents TO clientatlas_worker;
--> statement-breakpoint
GRANT UPDATE (page_count) ON public.document_versions TO clientatlas_worker;
--> statement-breakpoint

-- The worker is not a tenant, so its policies are keyed on the role rather than
-- on JWT claims: a background job has no user whose membership could be checked.
CREATE POLICY documents_worker_select ON public.documents
  FOR SELECT TO clientatlas_worker
  USING (true);
--> statement-breakpoint

CREATE POLICY documents_worker_update ON public.documents
  FOR UPDATE TO clientatlas_worker
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint

CREATE POLICY document_versions_worker_select ON public.document_versions
  FOR SELECT TO clientatlas_worker
  USING (true);
--> statement-breakpoint

CREATE POLICY document_versions_worker_update ON public.document_versions
  FOR UPDATE TO clientatlas_worker
  USING (true)
  WITH CHECK (true);
