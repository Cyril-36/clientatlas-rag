import { createHash } from "node:crypto";

import { SUPPORTED_MEDIA_TYPES, type SupportedMediaType } from "@clientatlas/contracts";

/**
 * Upload validation.
 *
 * Three things are checked independently and must agree: the filename
 * extension, the media type the client declared, and the bytes themselves. A
 * client controls the first two entirely, so neither is evidence of anything —
 * only the file signature is. Requiring agreement means a mislabelled file is
 * rejected rather than handed to a parser that expects something else.
 *
 * This is not malware scanning and does not pretend to be. It is the narrow
 * question "is this plausibly the format it claims to be, and small enough to
 * process", answered before anything touches storage.
 */

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Longest filename kept after sanitisation, extension included. */
const MAX_FILENAME_LENGTH = 200;

/**
 * C0 controls, DEL, C1 controls, and the bidirectional formatting characters.
 *
 * The last group matters more than it looks. A right-to-left override placed
 * before "fdp.exe" makes it render as "exe.pdf" in a file listing, so a name
 * that looks like a document is really an executable. None of these characters
 * belong in a filename, and stripping them keeps log lines honest as well.
 */
const UNSAFE_FILENAME_CHARS = new RegExp(
  "[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e]",
  "gu",
);

export type FileRejectionCode =
  "UNSUPPORTED_FILE_TYPE" | "FILE_TOO_LARGE" | "FILE_UNREADABLE" | "FILE_ENCRYPTED";

export interface AcceptedFile {
  readonly ok: true;
  readonly mediaType: SupportedMediaType;
  readonly sanitizedFilename: string;
  readonly checksumSha256: string;
  readonly byteSize: number;
}

export interface RejectedFile {
  readonly ok: false;
  readonly code: FileRejectionCode;
  /**
   * Safe to show a user and safe to log. Never contains file content, and never
   * echoes the raw filename back, since that is attacker-controlled text.
   */
  readonly message: string;
}

export type FileValidationResult = AcceptedFile | RejectedFile;

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_LOCAL_FILE_HEADER = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

const EXTENSION_BY_MEDIA_TYPE: Record<SupportedMediaType, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }

  return signature.every((byte, index) => bytes[index] === byte);
}

function contains(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(needle, "latin1"));
}

/**
 * Reduces a client-supplied filename to something safe to store and display.
 *
 * The filename never determines where bytes are written — storage paths are
 * built from database identifiers — so this is about display safety and sane
 * logs rather than traversal defence. Traversal is nonetheless stripped,
 * because relying on a single layer for that is how it eventually goes wrong.
 */
export function sanitizeFilename(filename: string): string {
  // Split on both separators: a Windows client sends backslashes, and a naive
  // split on "/" alone would keep the whole path.
  const base = filename.split(/[/\\]/).pop() ?? "";

  const cleaned = base.replace(UNSAFE_FILENAME_CHARS, "").replace(/\s+/g, " ").trim();

  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "document";
  }

  if (cleaned.length <= MAX_FILENAME_LENGTH) {
    return cleaned;
  }

  // Truncate the stem, not the extension: a name ending in ".pd" would be
  // rejected by the extension check on any later re-validation.
  const lastDot = cleaned.lastIndexOf(".");
  const extension = lastDot > 0 ? cleaned.slice(lastDot) : "";
  const stem = lastDot > 0 ? cleaned.slice(0, lastDot) : cleaned;

  return `${stem.slice(0, MAX_FILENAME_LENGTH - extension.length)}${extension}`;
}

function detectMediaType(bytes: Uint8Array): SupportedMediaType | null {
  if (startsWith(bytes, PDF_SIGNATURE)) {
    return "application/pdf";
  }

  if (startsWith(bytes, ZIP_LOCAL_FILE_HEADER)) {
    // Every DOCX is a ZIP, but not every ZIP is a DOCX. The Open Packaging
    // Convention requires "[Content_Types].xml", and WordprocessingML puts its
    // body under "word/". Both names appear in the archive directory as stored
    // text, so this separates a real DOCX from an arbitrary archive without
    // decompressing anything. Full structural validation happens at parse time.
    if (contains(bytes, "[Content_Types].xml") && contains(bytes, "word/")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }

    return null;
  }

  return null;
}

/**
 * A PDF that declares an /Encrypt dictionary needs a password the ingestion
 * worker does not have. Catching it here turns a confusing downstream parse
 * failure into a clear reason at upload time.
 */
function looksEncrypted(bytes: Uint8Array, mediaType: SupportedMediaType): boolean {
  return mediaType === "application/pdf" && contains(bytes, "/Encrypt");
}

export interface ValidateFileOptions {
  readonly filename: string;
  /** The media type the client claims. Treated as a claim, never as evidence. */
  readonly declaredMediaType: string;
  readonly bytes: Uint8Array;
  readonly maxBytes?: number;
}

export function validateFile(options: ValidateFileOptions): FileValidationResult {
  const { filename, declaredMediaType, bytes } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;

  if (bytes.length === 0) {
    return { ok: false, code: "FILE_UNREADABLE", message: "The file is empty." };
  }

  if (bytes.length > maxBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `The file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`,
    };
  }

  if (!(SUPPORTED_MEDIA_TYPES as readonly string[]).includes(declaredMediaType)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message: "Only PDF and DOCX files are supported.",
    };
  }

  const actualMediaType = detectMediaType(bytes);

  if (!actualMediaType) {
    return {
      ok: false,
      code: "FILE_UNREADABLE",
      message: "The file contents are not a readable PDF or DOCX.",
    };
  }

  if (actualMediaType !== declaredMediaType) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message: "The file contents do not match the declared file type.",
    };
  }

  const sanitizedFilename = sanitizeFilename(filename);
  const expectedExtension = EXTENSION_BY_MEDIA_TYPE[actualMediaType];

  if (!sanitizedFilename.toLowerCase().endsWith(expectedExtension)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message: `The file contents are ${expectedExtension.slice(1).toUpperCase()}, but the filename does not use ${expectedExtension}.`,
    };
  }

  if (looksEncrypted(bytes, actualMediaType)) {
    return {
      ok: false,
      code: "FILE_ENCRYPTED",
      message: "The file is password protected. Remove the password and upload it again.",
    };
  }

  return {
    ok: true,
    mediaType: actualMediaType,
    sanitizedFilename,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
}
