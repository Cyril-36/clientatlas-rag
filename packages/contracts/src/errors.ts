import { z } from "zod";

/**
 * Stable, machine-readable error codes.
 *
 * These are part of the public API surface: clients branch on `code`, never on
 * `message`. Messages may be reworded freely; codes may not be renamed or
 * reused for a different meaning.
 *
 * Nothing here may leak tenant data. A failure to find a record the caller is
 * not permitted to see must report `NOT_FOUND`, never `FORBIDDEN` — otherwise
 * the error code itself confirms the record exists in another organization.
 */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "RATE_LIMITED",
  "DEMO_READ_ONLY",
  "UNSUPPORTED_FILE_TYPE",
  "FILE_TOO_LARGE",
  "FILE_UNREADABLE",
  "INGESTION_FAILED",
  "NO_SUPPORTING_EVIDENCE",
  "CITATION_VALIDATION_FAILED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  /** Safe for display. Never contains document text, prompts, or credentials. */
  message: z.string().min(1),
  /** Correlates a client-visible failure with server logs and traces. */
  requestId: z.string().min(1),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
