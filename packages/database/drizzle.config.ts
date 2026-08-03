import { defineConfig } from "drizzle-kit";

/**
 * Migrations run as `migration_role`, which is the only credential permitted to
 * change schema. The application's request path uses `runtime_role`, which is
 * NOBYPASSRLS, non-owner and cannot migrate. Never point this config at the
 * runtime URL.
 */
const url = process.env["MIGRATION_DATABASE_URL"];

if (!url) {
  throw new Error(
    "MIGRATION_DATABASE_URL is not set. Copy .env.example to .env and fill it in; " +
      "there is deliberately no default, because a default would silently migrate the wrong database.",
  );
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
