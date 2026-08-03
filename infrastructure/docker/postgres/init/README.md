# PostgreSQL initialisation

Scripts here run **once**, when the `postgres-data` volume is first created.
They do not re-run against an existing volume.

If you change a file in this directory, the change will not appear in a
database you have already started. Recreate it:

```bash
docker compose down -v && docker compose up -d postgres
```

`down -v` deletes the volume and every row in it. That is fine for local
development and is never appropriate anywhere else.

Only extensions and other pre-schema setup belong here. Tables, roles and RLS
policies belong in versioned migrations under `packages/database/migrations`,
so that the local container and the hosted Supabase database converge on the
same state.
