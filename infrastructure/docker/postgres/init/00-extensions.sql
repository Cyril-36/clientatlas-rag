-- Extensions required before any migration runs.
--
-- This file executes once, on first initialisation of an empty data volume.
-- It is infrastructure, not schema: tables, roles and row-level security
-- policies belong in versioned Drizzle migrations so that the hosted Supabase
-- database and this local container converge on the same state.

-- Vector similarity search over 384-dimensional MiniLM embeddings.
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram matching, used for filename and title search alongside the
-- tsvector full-text index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is not required.
