import { randomUUID } from "node:crypto";

import type { ErrorCode } from "@clientatlas/contracts";
import * as schema from "@clientatlas/database/schema";
import { desc, eq } from "drizzle-orm";

import { ensureProfile } from "@/lib/auth/profile";
import { withTenantContext } from "@/lib/database/tenant";
import type { RequestContext } from "@/lib/http/request-context";
import {
  createUserStorageClient,
  documentsBucket,
  SIGNED_URL_TTL_SECONDS,
} from "@/lib/storage/client";
import { buildDocumentObjectPath } from "@/lib/storage/paths";

import { DEFAULT_MAX_FILE_BYTES, validateFile } from "./validation";

/**
 * Re-exported so route handlers can reject an oversized upload from the
 * Content-Length before buffering the body, without reaching past the service
 * into the validation module for a limit the service owns.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = DEFAULT_MAX_FILE_BYTES;

/**
 * Document operations.
 *
 * Authorisation is never checked here with an `if`. Every statement runs inside
 * `withTenantContext`, so the database decides: a workspace in another tenant
 * simply does not exist to this caller, and an insert they lack the role for is
 * refused by the policy. The service's job is ordering and cleanup, not
 * permission.
 */

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly status: string;
  readonly byteSize: number | null;
  readonly createdAt: string;
}

export interface CreateDocumentInput {
  readonly workspaceId: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * Accepts an upload.
 *
 * Bytes pass through the application rather than going straight to storage on a
 * signed URL. That is a deliberate trade: it costs a hop, and it is the only
 * point at which the file signature can be checked before anything is stored.
 * The bucket's own mime and size limits are a second line, not the first.
 *
 * Rows are written before the object, because the failure modes are not
 * symmetric. A row without an object is visible and can be marked failed or
 * cleaned up; an object without a row is invisible garbage nobody will ever
 * look for.
 */
export async function createDocument(
  context: RequestContext,
  input: CreateDocumentInput,
): Promise<ServiceResult<DocumentSummary>> {
  const validation = validateFile({
    filename: input.filename,
    declaredMediaType: input.declaredMediaType,
    bytes: input.bytes,
  });

  if (!validation.ok) {
    return { ok: false, code: validation.code as ErrorCode, message: validation.message };
  }

  const documentId = randomUUID();
  const versionId = randomUUID();

  const prepared = await withTenantContext(context.claims, async (tx) => {
    await ensureProfile(tx, context.claims);

    // RLS scopes this to workspaces the caller can see, so a workspace id from
    // another tenant yields nothing and is reported as not found — never as
    // forbidden, which would confirm it exists.
    const [workspace] = await tx
      .select({ id: schema.workspaces.id, organizationId: schema.workspaces.organizationId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId));

    if (!workspace) {
      return null;
    }

    const storagePath = buildDocumentObjectPath({
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      documentId,
      versionId,
      mediaType: validation.mediaType,
    });

    await tx.insert(schema.documents).values({
      id: documentId,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      title: validation.sanitizedFilename,
      originalFilename: validation.sanitizedFilename,
      mediaType: validation.mediaType,
      status: "queued",
    });

    await tx.insert(schema.documentVersions).values({
      id: versionId,
      organizationId: workspace.organizationId,
      documentId,
      versionNumber: 1,
      storagePath,
      byteSize: validation.byteSize,
      checksumSha256: validation.checksumSha256,
      uploadedBy: context.claims.sub,
    });

    // Enqueued in the same transaction as the version it refers to, so a
    // document can never exist without the job that would index it. Enqueuing
    // afterwards would leave a document stuck at `queued` for ever if the
    // process died in between, and nothing would ever notice.
    await tx.insert(schema.ingestionJobs).values({
      organizationId: workspace.organizationId,
      documentId,
      documentVersionId: versionId,
    });

    return { storagePath, organizationId: workspace.organizationId };
  });

  if (!prepared) {
    return { ok: false, code: "NOT_FOUND", message: "That workspace does not exist." };
  }

  const storage = documentsBucket(createUserStorageClient(context.accessToken));

  const { error } = await storage.upload(prepared.storagePath, input.bytes, {
    contentType: validation.mediaType,
  });

  if (error) {
    // Compensate. Best effort: if this also fails the row survives with status
    // `queued` and no object, which the ingestion worker will mark failed.
    await withTenantContext(context.claims, (tx) =>
      tx.delete(schema.documents).where(eq(schema.documents.id, documentId)),
    ).catch(() => undefined);

    return { ok: false, code: "INTERNAL_ERROR", message: "The file could not be stored." };
  }

  return {
    ok: true,
    value: {
      id: documentId,
      title: validation.sanitizedFilename,
      originalFilename: validation.sanitizedFilename,
      mediaType: validation.mediaType,
      status: "queued",
      byteSize: validation.byteSize,
      createdAt: new Date().toISOString(),
    },
  };
}

export async function listDocuments(
  context: RequestContext,
  workspaceId: string,
): Promise<DocumentSummary[]> {
  return withTenantContext(context.claims, async (tx) => {
    const rows = await tx
      .select({
        id: schema.documents.id,
        title: schema.documents.title,
        originalFilename: schema.documents.originalFilename,
        mediaType: schema.documents.mediaType,
        status: schema.documents.status,
        byteSize: schema.documentVersions.byteSize,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .leftJoin(
        schema.documentVersions,
        eq(schema.documentVersions.documentId, schema.documents.id),
      )
      .where(eq(schema.documents.workspaceId, workspaceId))
      .orderBy(desc(schema.documents.createdAt));

    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/** A short-lived download URL, or null if the caller cannot see the document. */
export async function createDownloadUrl(
  context: RequestContext,
  documentId: string,
): Promise<string | null> {
  const paths = await withTenantContext(context.claims, (tx) =>
    tx
      .select({ storagePath: schema.documentVersions.storagePath })
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, documentId))
      .orderBy(desc(schema.documentVersions.versionNumber))
      .limit(1),
  );

  const storagePath = paths[0]?.storagePath;

  if (!storagePath) {
    return null;
  }

  const storage = documentsBucket(createUserStorageClient(context.accessToken));
  const { data } = await storage.createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  return data?.signedUrl ?? null;
}

/**
 * Removes a document.
 *
 * Rows first, so the policy decides whether the caller may delete at all — a
 * caller without the role deletes nothing and gets back no rows. Objects are
 * removed afterwards using the paths the delete returned.
 */
export async function deleteDocument(
  context: RequestContext,
  documentId: string,
): Promise<boolean> {
  const removed = await withTenantContext(context.claims, async (tx) => {
    const versions = await tx
      .select({ storagePath: schema.documentVersions.storagePath })
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, documentId));

    const deleted = await tx
      .delete(schema.documents)
      .where(eq(schema.documents.id, documentId))
      .returning({ id: schema.documents.id });

    return deleted.length > 0 ? versions.map((version) => version.storagePath) : null;
  });

  if (removed === null) {
    return false;
  }

  if (removed.length > 0) {
    const storage = documentsBucket(createUserStorageClient(context.accessToken));
    await storage.remove(removed);
  }

  return true;
}
