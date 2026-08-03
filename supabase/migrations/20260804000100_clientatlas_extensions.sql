-- Extensions the tenant schema depends on.
--
-- Runs as `postgres`, which is the only role permitted to create extensions on
-- a Supabase project. Kept separate from the roles migration so that a failure
-- here is unambiguous about what failed.
--
-- The equivalent for the plain compose container lives in
-- `infrastructure/docker/postgres/init/00-extensions.sql`. Both must stay in
-- step, since migrations run against either one.

-- Vector similarity search over 384-dimensional MiniLM embeddings (M4).
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram matching for filename and title search, alongside the tsvector index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
