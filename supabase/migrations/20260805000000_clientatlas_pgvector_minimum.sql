-- pgvector 0.8.0 is a hard requirement, so refuse to run without it.
--
-- Retrieval sets `hnsw.iterative_scan`, which pgvector added in 0.8. Without
-- it, an HNSW scan behind a `workspace_id` predicate stops after `ef_search`
-- candidates whether or not enough of them survived the filter: a tenant
-- holding a small share of `document_chunks` gets a short page of results and
-- no error at all. Measured on the evaluation corpus, a workspace holding 3.6%
-- of the table returned a mean 0.07 of the passages an exact scan would, with
-- every query short.
--
-- It would be comfortable to assume an older pgvector fails loudly instead,
-- since the setting would not exist. It does not. pgvector registers its
-- settings when its shared library loads, and that happens on first use of a
-- vector operation rather than at connection time, so until then PostgreSQL
-- accepts any `hnsw.*` name as a placeholder. `vectorCandidates` issues its
-- `set local` before the query, which is exactly that window: on a server
-- without iterative scan the SET succeeds, the library then loads, and
-- PostgreSQL responds with
--
--   WARNING: invalid configuration parameter name "hnsw.iterative_scan",
--            removing it
--
-- and drops it. A warning on a connection nobody is reading, and a short page
-- of results. Later transactions on that same connection do raise, because the
-- prefix is reserved once the library is loaded — so the symptom is not even
-- consistent. Checked against this server rather than assumed.
--
-- That is why the floor is enforced here, in the database, rather than left to
-- a line of application code to notice.
--
-- One consequence of a migration whose entire body is a validation: it leaves
-- nothing behind. It raises, or it does nothing at all, so no table, column or
-- function can be inspected afterwards to tell whether it ever ran. The row in
-- `supabase_migrations.schema_migrations` is the only evidence, which is why
-- `apps/product-api/tests/integration/pgvector.test.ts` reads that table and
-- why `supabase/seed.sql` grants the test role access to it. Without that, a
-- database that had never applied this file passed the whole suite — which is
-- exactly what happened.
--
-- `CREATE EXTENSION IF NOT EXISTS vector` in the previous migration does not
-- cover it: on a server whose available pgvector is older, that succeeds and
-- installs the old version.

DO $$
DECLARE
  installed text;
BEGIN
  SELECT extversion INTO installed FROM pg_extension WHERE extname = 'vector';

  IF installed IS NULL THEN
    RAISE EXCEPTION 'the vector extension is not installed'
      USING HINT = 'the extensions migration should have created it';
  END IF;

  -- Compared as integer arrays rather than as text, so that 0.10.0 is not
  -- judged older than 0.8.0. pgvector versions are plain `major.minor.patch`.
  IF string_to_array(installed, '.')::int[] < ARRAY[0, 8, 0] THEN
    RAISE EXCEPTION 'pgvector % is too old; ClientAtlas requires 0.8.0 or newer', installed
      USING DETAIL = 'retrieval sets hnsw.iterative_scan, which pgvector added in 0.8.0. '
                     'Without it an HNSW scan behind a tenant filter silently returns '
                     'fewer rows than requested.',
            HINT = 'upgrade the server''s pgvector, then run ALTER EXTENSION vector UPDATE.';
  END IF;
END
$$;
