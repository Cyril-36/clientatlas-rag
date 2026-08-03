import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Tenant schema.
 *
 * Two conventions hold for every tenant-owned table:
 *
 *  1. It carries an `organization_id` column even where the value could be
 *     derived through joins. Policies and cross-tenant tests are far easier to
 *     reason about when the tenant key is always one column away, and a policy
 *     that has to traverse three joins is a policy nobody audits.
 *  2. It runs with both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL
 *     SECURITY`. `ENABLE` alone still exempts the table owner, and migrations
 *     run as the owner.
 *
 * Neither convention is expressible in Drizzle, so both live in the hand-written
 * RLS migration and are asserted by the integration tests rather than trusted.
 */

/** Standard audit columns. Spread into every table definition. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const organizationRole = pgEnum("organization_role", ["owner", "admin", "editor", "viewer"]);

/**
 * One row per authenticated user.
 *
 * `id` mirrors the Supabase `auth.users` identifier. The foreign key to
 * `auth.users` is added when Supabase Auth is wired in; locally there is no
 * `auth` schema to reference, and the integration tests seed these rows the way
 * Supabase's signup trigger would.
 */
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  ...timestamps,
});

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * Gates the hosted generation provider. Only a synthetic organization's
     * content may ever reach a third party, so this column is load-bearing
     * rather than descriptive.
     */
    isSynthetic: boolean("is_synthetic").notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex("organizations_slug_key").on(table.slug)],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: organizationRole("role").notNull().default("viewer"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("organization_members_org_user_key").on(table.organizationId, table.userId),
    index("organization_members_user_idx").on(table.userId),
  ],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workspaces_org_slug_key").on(table.organizationId, table.slug),
    index("workspaces_org_idx").on(table.organizationId),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
