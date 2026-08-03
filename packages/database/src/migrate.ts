import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Applies pending migrations as `clientatlas_migration`.
 *
 * Used instead of `drizzle-kit migrate` because the CLI has no non-interactive
 * guarantee and offers no useful output when a statement fails — which, for the
 * file that establishes row-level security, is the moment output matters most.
 * This runs the same journal, in the same order, and reports what broke.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const envFile = path.join(repoRoot, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const url = process.env["MIGRATION_DATABASE_URL"];

if (!url) {
  throw new Error(
    "MIGRATION_DATABASE_URL is not set. Copy .env.example to .env and fill it in; " +
      "there is deliberately no default, because a default would silently migrate the wrong database.",
  );
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const [role] = await sql<{ current_user: string; is_superuser: boolean }[]>`
    select current_user, usesuper as is_superuser from pg_user where usename = current_user
  `;

  // A superuser owner would silently defeat FORCE ROW LEVEL SECURITY on every
  // table this migration creates, and the cross-tenant tests would pass while
  // proving nothing. Refuse rather than produce that outcome.
  if (role?.is_superuser) {
    throw new Error(
      `Refusing to migrate as superuser '${role.current_user}'. FORCE ROW LEVEL SECURITY ` +
        "does not apply to superusers, so the table owner would bypass every policy. " +
        "Point MIGRATION_DATABASE_URL at clientatlas_migration.",
    );
  }

  process.stdout.write(`applying migrations as ${role?.current_user ?? "unknown"}\n`);

  await migrate(drizzle(sql), { migrationsFolder: path.join(here, "..", "migrations") });

  process.stdout.write("migrations applied\n");
} finally {
  await sql.end();
}
