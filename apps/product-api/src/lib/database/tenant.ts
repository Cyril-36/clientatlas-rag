import { sql } from "drizzle-orm";

import type { VerifiedClaims } from "@/lib/auth/claims";

import { getRuntimeDatabase, type RuntimeDatabase } from "./client";

export type TenantTransaction = Parameters<Parameters<RuntimeDatabase["transaction"]>[0]>[0];

/**
 * The only sanctioned path to tenant data.
 *
 * Every user-scoped statement runs inside one transaction that:
 *
 *   1. writes the verified claims into `request.jwt.claims` transaction-locally,
 *   2. assumes the fixed `authenticated` role,
 *   3. runs the caller's queries,
 *   4. commits or rolls back, returning the connection to the pool clean.
 *
 * `set_config(..., true)` and `SET LOCAL ROLE` are both scoped to the
 * transaction, so no state survives into the next request that borrows the same
 * connection. That property is what makes a pooled connection safe here, and it
 * is why the role switch must never be replaced with a plain `SET ROLE`.
 *
 * Ordering matters. Claims are written first, while still connected as
 * `clientatlas_runtime`; the role switch is last, so everything the caller runs
 * is evaluated as `authenticated` with the claims already in place.
 *
 * The claims object is serialised whole, so it must be the narrow verified
 * shape — never a raw token payload.
 */
export async function withTenantContext<T>(
  claims: VerifiedClaims,
  run: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const database = getRuntimeDatabase();

  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`);

    // Not parameterisable — role names are identifiers, not values. It is a
    // compile-time constant for exactly that reason.
    //
    // A statement that managed to `RESET ROLE` would land back on
    // clientatlas_runtime, which holds no table privileges at all, so the
    // escape leads somewhere strictly less useful than where it started.
    await tx.execute(sql`set local role authenticated`);

    return run(tx);
  });
}

/**
 * Reads back what the database believes about the current transaction.
 *
 * Used by the integration tests to prove the contract actually took effect,
 * rather than inferring it from the fact that no error was thrown.
 */
export async function readTenantContext(
  tx: TenantTransaction,
): Promise<{ currentRole: string; currentUserId: string | null }> {
  const rows = await tx.execute<{ current_role: string; current_user_id: string | null }>(
    sql`select current_user as current_role, app.current_user_id()::text as current_user_id`,
  );

  const row = Array.from(
    rows as Iterable<{ current_role: string; current_user_id: string | null }>,
  )[0];

  if (!row) {
    throw new Error("Could not read the current tenant context.");
  }

  return { currentRole: row.current_role, currentUserId: row.current_user_id };
}
