import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
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
 * `id` mirrors the Supabase `auth.users` identifier, but there is deliberately
 * no foreign key to it. GoTrue re-runs its own migrations on startup and resets
 * permissions on the `auth` schema, so the grant needed to declare that
 * constraint does not survive. The relationship holds anyway: `id` only ever
 * comes from a cryptographically verified token, and the row is created on the
 * first authenticated request rather than by a trigger.
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

export const ingestionJobStatus = pgEnum("ingestion_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

/**
 * The ingestion work queue.
 *
 * PostgreSQL rather than Redis. The volume this project will ever see is far
 * below the point where a dedicated broker earns its operational cost, and
 * keeping the queue in the same database means a job and the rows it produces
 * commit or roll back together. Redis becomes worth adding when measurements
 * say so, not before.
 */
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull(),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),

    status: ingestionJobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    /** Not eligible to be claimed before this. Carries the retry backoff. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),

    /** Identifies the worker holding the claim, for diagnosis rather than locking. */
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /**
     * Refreshed while work is in progress. A running job whose heartbeat has
     * gone stale is assumed abandoned — a worker that was killed mid-parse
     * cannot release its own claim, so something has to.
     */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),

    /** A stable code, never raw parser output, which can contain document text. */
    failureCode: text("failure_code"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.documentId, table.organizationId],
      foreignColumns: [documents.id, documents.organizationId],
      name: "ingestion_jobs_document_org_fk",
    }).onDelete("cascade"),
    /**
     * The claim query's index. Partial, because only queued rows are ever
     * scanned for work — a full index would grow without bound as succeeded
     * jobs accumulate, while the interesting set stays small.
     */
    index("ingestion_jobs_claimable_idx")
      .on(table.runAfter)
      .where(sql`status = 'queued'`),
    index("ingestion_jobs_heartbeat_idx")
      .on(table.heartbeatAt)
      .where(sql`status = 'running'`),
    index("ingestion_jobs_document_idx").on(table.documentId),
  ],
);

/**
 * One retrievable unit of document text.
 *
 * Carries both the embedding and the full-text vector, because retrieval fuses
 * a keyword search and a vector search over the same rows.
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    documentId: uuid("document_id").notNull(),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),

    /** Position within the version, from 1. Cited back to the user. */
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    pageNumber: integer("page_number"),
    /** Outermost heading first, so a citation can be shown in context. */
    headingPath: text("heading_path")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    tokenCount: integer("token_count").notNull(),

    embedding: vector("embedding", { dimensions: 384 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "document_chunks_workspace_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("document_chunks_version_ordinal_key").on(table.documentVersionId, table.ordinal),
    index("document_chunks_workspace_idx").on(table.workspaceId),
  ],
);

export type Profile = typeof profiles.$inferSelect;
/* -------------------------------------------------------------------------- */
/* Generated artifacts                                                        */
/* -------------------------------------------------------------------------- */

export const artifactKind = pgEnum("artifact_kind", [
  "readiness_report",
  "onboarding_brief",
  "faq",
  "action_plan",
]);

/**
 * A generated document that belongs to a workspace.
 *
 * The row itself carries almost nothing: a kind, a title, and which version is
 * current. Everything a reader sees lives in `artifact_versions`, because an
 * artifact whose content could be edited in place would make every citation
 * ever shown unverifiable — the evidence rows point at a version, and a version
 * that can change is not evidence of anything.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    kind: artifactKind("kind").notNull(),
    title: text("title").notNull(),
    /**
     * Which version is shown. Nullable only between inserting the artifact and
     * its first version, which happens inside one transaction.
     */
    currentVersionId: uuid("current_version_id"),
    ...timestamps,
  },
  (table) => [
    // The same composite reference the documents table uses, and for the same
    // reason: a cross-tenant parent is rejected by the database before any
    // policy is consulted.
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "artifacts_workspace_org_fk",
    }).onDelete("cascade"),
    index("artifacts_workspace_kind_idx").on(table.workspaceId, table.kind),
    unique("artifacts_id_org_key").on(table.id, table.organizationId),
  ],
);

/**
 * One immutable revision of an artifact.
 *
 * Editing appends. There is no `updated_at` and no UPDATE policy, so a version
 * a citation refers to cannot become a different version later — the same rule
 * `document_versions` follows, for the same reason.
 *
 * `sections` is structured JSON rather than prose: a section is the unit that
 * carries evidence, and a wall of markdown cannot say which sentence rested on
 * which passage.
 */
export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    /** `{ sections: [{ key, heading, body, ... }] }`, validated by contract. */
    sections: jsonb("sections").notNull(),
    /**
     * Who wrote this revision: the generator, or a person editing it. Kept so a
     * reader can tell a machine's claim from a human's, which matters most
     * where the two disagree.
     */
    authoredBy: uuid("authored_by").references(() => profiles.id, { onDelete: "set null" }),
    generated: boolean("generated").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.artifactId, table.organizationId],
      foreignColumns: [artifacts.id, artifacts.organizationId],
      name: "artifact_versions_artifact_org_fk",
    }).onDelete("cascade"),
    unique("artifact_versions_artifact_number_key").on(table.artifactId, table.versionNumber),
    unique("artifact_versions_id_org_key").on(table.id, table.organizationId),
    index("artifact_versions_artifact_idx").on(table.artifactId),
  ],
);

/**
 * The passage one section of one version rested on.
 *
 * This is what makes a generated artifact checkable rather than merely
 * plausible. It points at a chunk, and the chunk points at a document version,
 * so "where did this come from" resolves all the way down to bytes that cannot
 * have changed since.
 *
 * `chunkId` is deliberately not a foreign key with `cascade`: re-indexing a
 * document replaces its chunks, and an artifact must not silently lose its
 * evidence because the corpus was rebuilt. The reference is recorded and
 * resolved at read time, which lets the reader be told "this citation refers to
 * a passage that no longer exists" rather than shown a report that quietly has
 * fewer sources than it was written with.
 */
export const artifactEvidence = pgTable(
  "artifact_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id").notNull(),
    /** Which section of the version this supports. */
    sectionKey: text("section_key").notNull(),
    /** The number shown to a reader, contiguous from 1 within a section. */
    ordinal: integer("ordinal").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    documentId: uuid("document_id").notNull(),
    /** Snapshotted, so a citation still reads correctly if the chunk is gone. */
    documentTitle: text("document_title").notNull(),
    pageNumber: integer("page_number"),
    quote: text("quote").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.artifactVersionId, table.organizationId],
      foreignColumns: [artifactVersions.id, artifactVersions.organizationId],
      name: "artifact_evidence_version_org_fk",
    }).onDelete("cascade"),
    unique("artifact_evidence_section_ordinal_key").on(
      table.artifactVersionId,
      table.sectionKey,
      table.ordinal,
    ),
    index("artifact_evidence_version_idx").on(table.artifactVersionId),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type ArtifactVersion = typeof artifactVersions.$inferSelect;
export type ArtifactEvidence = typeof artifactEvidence.$inferSelect;
