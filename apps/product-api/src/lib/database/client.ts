import * as schema from "@clientatlas/database/schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/lib/env";

export type RuntimeDatabase = PostgresJsDatabase<typeof schema>;

/**
 * The connection pool the application serves requests on.
 *
 * It authenticates as `clientatlas_runtime`, which is NOINHERIT and NOBYPASSRLS
 * and has been granted no table privileges of its own. A query issued on this
 * pool without first assuming the `authenticated` role therefore fails with a
 * permission error rather than returning unfiltered rows — the failure mode of
 * forgetting the claims helper is a broken endpoint, not a data leak.
 *
 * Reach for `withTenantContext` instead of exporting this. It is exported only
 * so the tenant helper and the role-safety assertions can use it.
 */

const globalForDatabase = globalThis as unknown as {
  __clientatlasRuntimeSql?: ReturnType<typeof postgres>;
  __clientatlasRuntimeDb?: RuntimeDatabase;
};

export function getRuntimeSql(): ReturnType<typeof postgres> {
  // Next.js reloads modules on every edit in development; without this the
  // process accumulates a new pool per reload until PostgreSQL refuses more.
  globalForDatabase.__clientatlasRuntimeSql ??= postgres(getServerEnv().RUNTIME_DATABASE_URL, {
    max: 10,
    // Document text and identifiers must never reach a log line.
    onnotice: () => {},
  });

  return globalForDatabase.__clientatlasRuntimeSql;
}

export function getRuntimeDatabase(): RuntimeDatabase {
  globalForDatabase.__clientatlasRuntimeDb ??= drizzle(getRuntimeSql(), { schema });
  return globalForDatabase.__clientatlasRuntimeDb;
}

export interface RuntimeRoleAttributes {
  readonly roleName: string;
  readonly isSuperuser: boolean;
  readonly canBypassRls: boolean;
  readonly inheritsPrivileges: boolean;
}

/**
 * Reads the attributes of the role the runtime pool is actually connected as.
 *
 * Configuration drifts. This is what lets a test — or a readiness check —
 * assert that the credential in use is still the constrained one, rather than
 * trusting that whoever wrote the connection string got it right.
 */
export async function readRuntimeRoleAttributes(): Promise<RuntimeRoleAttributes> {
  const sql = getRuntimeSql();

  const [row] = await sql<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }[]
  >`
    select rolname, rolsuper, rolbypassrls, rolinherit
    from pg_roles
    where rolname = current_user
  `;

  if (!row) {
    throw new Error("Could not read the current role's attributes.");
  }

  return {
    roleName: row.rolname,
    isSuperuser: row.rolsuper,
    canBypassRls: row.rolbypassrls,
    inheritsPrivileges: row.rolinherit,
  };
}
