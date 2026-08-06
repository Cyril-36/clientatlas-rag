-- Local development seed.
--
-- Supabase runs this file only against a local stack — `supabase start` and
-- `supabase db reset`. It is never applied to a hosted project, which is why it
-- is the right and only place for development credentials.
--
-- These passwords are local-loopback only. They are committed deliberately so
-- that a fresh clone works with no manual step, and they are worth exactly
-- nothing outside this machine. A hosted project's roles get real passwords set
-- once, by hand, and those never enter this repository.

ALTER ROLE clientatlas_migration WITH PASSWORD 'local_migration_only';
ALTER ROLE clientatlas_runtime   WITH PASSWORD 'local_runtime_only';
ALTER ROLE clientatlas_worker    WITH PASSWORD 'local_worker_only';
ALTER ROLE clientatlas_test      WITH PASSWORD 'local_test_only';

-- Read access to the migration history, for the test role only.
--
-- `tests/integration/pgvector.test.ts` asserts that every migration in the
-- repository has actually been applied to the database it is testing. That
-- check exists because the pgvector floor is enforced by a migration whose
-- entire body is a validation — it raises or it does nothing — so it leaves no
-- schema artifact behind. The row in `schema_migrations` is the only evidence
-- that it ever ran, and without this grant the suite cannot look: it passed
-- against a local stack that had never applied the migration at all.
--
-- Read-only, on metadata, for the role that only exists to run tests. The
-- runtime and worker roles are deliberately left without it — nothing they do
-- has any business knowing which migrations exist.
--
-- Local and CI only, like everything else in this file.
GRANT USAGE ON SCHEMA supabase_migrations TO clientatlas_test;
GRANT SELECT ON supabase_migrations.schema_migrations TO clientatlas_test;
