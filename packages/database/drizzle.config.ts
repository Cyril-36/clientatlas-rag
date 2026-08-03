import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

// Load the repository-root .env so drizzle-kit sees the same values the
// applications do. Node's built-in loader is used rather than a dependency.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = path.join(repoRoot, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * Migrations run as `clientatlas_migration`, the only credential permitted to
 * change schema. It is deliberately not a superuser and does not hold BYPASSRLS,
 * so that FORCE ROW LEVEL SECURITY constrains the table owner too.
 *
 * Never point this at the runtime URL, and never at a superuser.
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
  // `strict` prompts for interactive confirmation, which hangs forever in CI and
  // in any non-interactive shell. Migrations here are reviewed SQL files applied
  // in order, so the prompt adds nothing that review has not already done.
  strict: false,
  verbose: true,
});
