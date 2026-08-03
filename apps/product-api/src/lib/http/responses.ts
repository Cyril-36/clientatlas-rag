import { type ErrorCode } from "@clientatlas/contracts";
import { NextResponse } from "next/server";

/**
 * HTTP responses.
 *
 * Every failure carries a stable `code` and a `requestId`. Clients branch on
 * the code and never on the message, so messages stay free to be reworded.
 *
 * The status mapping deliberately reports NOT_FOUND rather than FORBIDDEN for
 * anything the caller is not permitted to see. Row-level security makes another
 * tenant's rows invisible rather than refused, and the HTTP layer must not
 * undo that by confirming, through a 403, that the record exists somewhere.
 */

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  DEMO_READ_ONLY: 403,
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  FILE_UNREADABLE: 422,
  INGESTION_FAILED: 500,
  NO_SUPPORTING_EVIDENCE: 422,
  CITATION_VALIDATION_FAILED: 500,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export function errorResponse(code: ErrorCode, message: string, requestId: string): NextResponse {
  return NextResponse.json(
    { code, message, requestId },
    { status: STATUS_BY_CODE[code], headers: { "x-request-id": requestId } },
  );
}

export function okResponse<T>(body: T, requestId: string, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId } });
}
