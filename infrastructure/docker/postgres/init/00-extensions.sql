-- Extensions required before any migration runs.
--
-- This file executes once, on first initialisation of an empty data volume.
-- It is infrastructure, not schema: tables, roles and row-level security
-- policies belong in versioned Drizzle migrations so that the hosted Supabase
-- database and this local container converge on the same state.

-- Vector similarity search over 384-dimensional MiniLM embeddings.
CREATE EXTENSION IF NOT EXISTS vector;

-- 0.8.0 or newer, checked here as well as in
-- supabase/migrations/20260805000000_clientatlas_pgvector_minimum.sql, because
-- the two initialisation paths do not share files. Retrieval sets
-- `hnsw.iterative_scan`, added in pgvector 0.8; below that an HNSW scan behind
-- a tenant filter returns short pages with no error. Failing here means an
-- empty container rather than a working one that under-retrieves.
DO $$
DECLARE
  installed text;
BEGIN
  SELECT extversion INTO installed FROM pg_extension WHERE extname = 'vector';

  -- Integer arrays, so that 0.10.0 does not sort below 0.8.0 as text would.
  IF string_to_array(installed, '.')::int[] < ARRAY[0, 8, 0] THEN
    RAISE EXCEPTION 'pgvector % is too old; ClientAtlas requires 0.8.0 or newer', installed
      USING HINT = 'the pinned image in docker-compose.yml carries a supported version.';
  END IF;
END
$$;

-- Trigram matching, used for filename and title search alongside the
-- tsvector full-text index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is not required.
