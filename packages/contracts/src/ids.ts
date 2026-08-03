import { z } from "zod";

/**
 * Branded identifier schemas.
 *
 * Branding is deliberate: an `OrganizationId` must never be passed where a
 * `WorkspaceId` is expected. Every tenant-owned table carries an
 * `organization_id` even where it could be derived through joins, so these two
 * are the identifiers that appear most often and are the easiest to transpose.
 */

const uuidString = () => z.string().uuid();

export const organizationIdSchema = uuidString().brand<"OrganizationId">();
export const workspaceIdSchema = uuidString().brand<"WorkspaceId">();
export const documentIdSchema = uuidString().brand<"DocumentId">();
export const documentVersionIdSchema = uuidString().brand<"DocumentVersionId">();
export const chunkIdSchema = uuidString().brand<"ChunkId">();
export const userIdSchema = uuidString().brand<"UserId">();

export type OrganizationId = z.infer<typeof organizationIdSchema>;
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type DocumentId = z.infer<typeof documentIdSchema>;
export type DocumentVersionId = z.infer<typeof documentVersionIdSchema>;
export type ChunkId = z.infer<typeof chunkIdSchema>;
export type UserId = z.infer<typeof userIdSchema>;

export const organizationRoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;
