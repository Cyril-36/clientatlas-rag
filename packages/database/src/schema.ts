import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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
  /**
   * Nullable because not every Supabase auth method carries one — phone and
   * anonymous sign-ins do not. Storing a synthesised placeholder to satisfy a
   * NOT NULL would put a value in the column that is not the user's address.
   */
  email: text("email"),
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
    /**
     * Redundant on its own — `id` is already unique — but it gives child tables
     * something to point a *composite* foreign key at. See `documents`.
     */
    unique("workspaces_id_org_key").on(table.id, table.organizationId),
  ],
);

export const documentStatus = pgEnum("document_status", [
  "queued",
  "processing",
  "ready",
  "failed",
]);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    title: text("title").notNull(),
    originalFilename: text("original_filename").notNull(),
    mediaType: text("media_type").notNull(),
    status: documentStatus("status").notNull().default("queued"),
    /** Safe diagnostic code when status is `failed`. Never raw parser output. */
    failureCode: text("failure_code"),
    ...timestamps,
  },
  (table) => [
    /**
     * The composite key is the point.
     *
     * A plain `workspace_id -> workspaces.id` reference would happily accept
     * another tenant's workspace; only the RLS policy would object, and only if
     * the policy is right. Referencing (id, organization_id) together makes a
     * cross-tenant parent structurally impossible — the database rejects it
     * before any policy is consulted.
     */
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "documents_workspace_org_fk",
    }).onDelete("cascade"),
    index("documents_workspace_idx").on(table.workspaceId),
    index("documents_org_status_idx").on(table.organizationId, table.status),
    unique("documents_id_org_key").on(table.id, table.organizationId),
  ],
);

/**
 * An immutable record of one uploaded file.
 *
 * Versions are never updated: re-uploading produces a new row, and re-indexing
 * derives new data from an existing one. There is deliberately no `updated_at`
 * and no UPDATE policy, so "the bytes behind this citation changed" is not a
 * state the system can reach.
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    storagePath: text("storage_path").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    /** Null until the parser has run. */
    pageCount: integer("page_count"),
    uploadedBy: uuid("uploaded_by").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId, table.organizationId],
      foreignColumns: [documents.id, documents.organizationId],
      name: "document_versions_document_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("document_versions_document_number_key").on(table.documentId, table.versionNumber),
    uniqueIndex("document_versions_storage_path_key").on(table.storagePath),
    index("document_versions_checksum_idx").on(table.organizationId, table.checksumSha256),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentVersion = typeof documentVersions.$inferSelect;
