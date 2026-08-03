-- Row-level security, full-text and vector indexes for the ingestion tables.
--
-- The interesting question here is how the worker reaches these rows at all.
-- It processes jobs for every tenant, so it cannot be scoped by JWT claims —
-- there is no user on a background job.
--
-- The tempting answer is to give clientatlas_worker BYPASSRLS. That is rejected:
-- it would create a second credential able to read every tenant's data through
-- any table, and the value of the whole design is that no such credential
-- exists on the request path or near it.
--
-- Instead the worker gets policies of its own, targeted at exactly two tables.
-- `TO clientatlas_worker USING (true)` is broad *within* ingestion_jobs and
-- document_chunks, and grants nothing anywhere else. Adding a third table to
-- this list is a decision someone has to make deliberately, in review, rather
-- than a privilege that silently already applied.

ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ingestion_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.document_chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ===========================================================================
-- Full-text and vector indexes
-- ===========================================================================

-- Generated, not maintained by the application: a trigger or an application
-- write can be forgotten, and a chunk missing from the keyword index is
-- invisible to half of hybrid retrieval while looking perfectly fine in a row.
ALTER TABLE public.document_chunks
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
--> statement-breakpoint

CREATE INDEX document_chunks_tsv_idx
  ON public.document_chunks USING gin (content_tsv);
--> statement-breakpoint

-- HNSW rather than IVFFlat: it needs no training step and no rebuild as rows
-- arrive, which matters when documents are ingested continuously rather than
-- loaded in one batch. Cosine, matching how MiniLM embeddings are compared.
CREATE INDEX document_chunks_embedding_idx
  ON public.document_chunks USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint

-- ===========================================================================
-- Grants
-- ===========================================================================

GRANT SELECT, INSERT ON public.ingestion_jobs TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.document_chunks TO authenticated;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingestion_jobs TO clientatlas_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_chunks TO clientatlas_worker;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO clientatlas_worker;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO clientatlas_worker;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.ingestion_jobs TO clientatlas_test;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.document_chunks TO clientatlas_test;
--> statement-breakpoint

-- ===========================================================================
-- ingestion_jobs
-- ===========================================================================

-- Members watch progress; they do not drive it.
CREATE POLICY ingestion_jobs_select_member ON public.ingestion_jobs
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

-- Enqueuing happens on upload and on a re-index request, both of which are
-- editor actions.
CREATE POLICY ingestion_jobs_insert_editor ON public.ingestion_jobs
  FOR INSERT TO authenticated
  WITH CHECK (
    app.has_org_role(organization_id, ARRAY['owner', 'admin', 'editor']::public.organization_role[])
  );
--> statement-breakpoint

-- No UPDATE or DELETE for users. Job state belongs to the worker; a user who
-- could mark a job succeeded could make a document appear indexed when it is
-- not, and every answer drawn from it would be silently incomplete.

CREATE POLICY ingestion_jobs_worker_all ON public.ingestion_jobs
  FOR ALL TO clientatlas_worker
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint

-- ===========================================================================
-- document_chunks
-- ===========================================================================

CREATE POLICY document_chunks_select_member ON public.document_chunks
  FOR SELECT TO authenticated
  USING (app.is_org_member(organization_id));
--> statement-breakpoint

-- Chunks are derived data. A user cannot write one, so a citation can never
-- point at text a user authored and passed off as document content.

CREATE POLICY document_chunks_worker_all ON public.document_chunks
  FOR ALL TO clientatlas_worker
  USING (true)
  WITH CHECK (true);
