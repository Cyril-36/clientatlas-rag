import type { SupportedMediaType } from "@clientatlas/contracts";

/**
 * Object paths for the `documents` bucket.
 *
 * The path is not decoration: `app.storage_org_id()` parses the organisation
 * out of it, and the storage policies decide access from that. This module and
 * that SQL function are two implementations of one format, so they are tested
 * against each other rather than trusted to stay in step.
 *
 * Every segment comes from a database identifier. Nothing a user typed — least
 * of all a filename — ever reaches a path, which is why traversal is not a
 * question of escaping but of never interpolating untrusted text at all.
 */

export const DOCUMENTS_BUCKET = "documents";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EXTENSION_BY_MEDIA_TYPE: Record<SupportedMediaType, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export interface DocumentObjectLocation {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly mediaType: SupportedMediaType;
}

export class InvalidStoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStoragePathError";
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    // Refuse rather than sanitise. A non-UUID here means a caller passed
    // something that did not come from the database, and quietly cleaning it up
    // would hide that.
    throw new InvalidStoragePathError(`${label} is not a UUID.`);
  }
}

export function buildDocumentObjectPath(location: DocumentObjectLocation): string {
  assertUuid(location.organizationId, "organizationId");
  assertUuid(location.workspaceId, "workspaceId");
  assertUuid(location.documentId, "documentId");
  assertUuid(location.versionId, "versionId");

  const extension = EXTENSION_BY_MEDIA_TYPE[location.mediaType];

  return [
    "organizations",
    location.organizationId,
    "workspaces",
    location.workspaceId,
    "documents",
    location.documentId,
    `${location.versionId}.${extension}`,
  ].join("/");
}

export interface ParsedDocumentObjectPath {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly extension: string;
}

/**
 * Inverse of `buildDocumentObjectPath`.
 *
 * Returns null for anything that does not match exactly, mirroring the SQL
 * helper's decision to yield NULL rather than raise. Both sides fail closed.
 */
export function parseDocumentObjectPath(path: string): ParsedDocumentObjectPath | null {
  const segments = path.split("/");

  if (segments.length !== 7) {
    return null;
  }

  const [organizations, organizationId, workspaces, workspaceId, documents, documentId, filename] =
    segments;

  if (
    organizations !== "organizations" ||
    workspaces !== "workspaces" ||
    documents !== "documents"
  ) {
    return null;
  }

  if (
    !organizationId ||
    !workspaceId ||
    !documentId ||
    !filename ||
    !UUID_PATTERN.test(organizationId) ||
    !UUID_PATTERN.test(workspaceId) ||
    !UUID_PATTERN.test(documentId)
  ) {
    return null;
  }

  const dot = filename.lastIndexOf(".");

  if (dot <= 0) {
    return null;
  }

  const versionId = filename.slice(0, dot);
  const extension = filename.slice(dot + 1);

  if (!UUID_PATTERN.test(versionId) || !/^[a-z0-9]+$/.test(extension)) {
    return null;
  }

  return { organizationId, workspaceId, documentId, versionId, extension };
}

/** The organisation a path belongs to, or null. Mirrors `app.storage_org_id`. */
export function organizationIdFromPath(path: string): string | null {
  return parseDocumentObjectPath(path)?.organizationId ?? null;
}
