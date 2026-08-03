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
