import { timestamp } from "drizzle-orm/pg-core";

/**
 * Tenant schema.
 *
 * Tables land in M2 (identity and tenancy) onward. Two conventions hold for
 * every tenant-owned table added here:
 *
 *  1. It carries an `organization_id` column even where the value could be
 *     derived through joins. RLS policies and cross-tenant tests are far easier
 *     to reason about when the tenant key is always one column away.
 *  2. It is created with both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL
 *     SECURITY`. `ENABLE` alone still exempts the table owner, and migrations
 *     run as the owner.
 *
 * Neither convention is enforced by Drizzle, so both are asserted by the
 * cross-tenant integration tests rather than trusted.
 */

/** Standard audit columns. Spread into every table definition. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
