import { randomUUID } from "node:crypto";

import { bearerTokenFrom, InvalidTokenError, verifyAccessToken } from "@/lib/auth/claims";
import type { VerifiedClaims } from "@/lib/auth/claims";
import {
  ACCESS_COOKIE,
  assertSameOrigin,
  cookieFrom,
  CrossSiteRequestError,
} from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env";

import { errorResponse } from "./responses";

/**
 * The single entry point for an authenticated request.
 *
 * Every tenant-touching route goes through this. It verifies the bearer token,
 * enforces demo mode, allocates a request id, and turns anything thrown into a
 * safe response — so a handler never has to remember to do any of it, and a
 * handler that forgets cannot accidentally serve unauthenticated traffic.
 */

export interface RequestContext {
  /** Verified, narrowed claims. Safe to hand to the database claims helper. */
  readonly claims: VerifiedClaims;
  /**
   * The raw access token, needed because Supabase Storage authenticates the
   * caller itself. It is passed on, never logged and never persisted.
   */
  readonly accessToken: string;
  readonly requestId: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function withAuthenticatedRequest(
  request: Request,
  handler: (context: RequestContext) => Promise<Response>,
): Promise<Response> {
  const requestId = randomUUID();

  // Demo mode is checked before authentication, so a hosted demo cannot be
  // probed for which mutations exist by watching which ones return 401 first.
  if (getServerEnv().CLIENTATLAS_MODE === "demo" && !SAFE_METHODS.has(request.method)) {
    return errorResponse(
      "DEMO_READ_ONLY",
      "This deployment is a read-only demonstration. Run it locally to upload documents.",
      requestId,
    );
  }

  // Cross-site protection before authentication, and before any work.
  //
  // Cookies are ambient authority: the browser attaches them to a form post
  // from any site. `SameSite=Lax` already stops that, and this is the second
  // lock — enforced here rather than per route, because a route that forgets it
  // is a CSRF hole, and the only reliable way to not forget is to make it
  // impossible to reach a handler without passing.
  try {
    assertSameOrigin(request);
  } catch (error: unknown) {
    if (error instanceof CrossSiteRequestError) {
      return errorResponse(
        "FORBIDDEN",
        "This request did not originate from this site.",
        requestId,
      );
    }
    throw error;
  }

  // A browser session first, then a bearer token.
  //
  // The cookie is how the UI authenticates and how a browser must: it is
  // `HttpOnly`, so no script on the page can read it, which matters in a
  // product that renders text from documents its tenants uploaded. The bearer
  // header stays supported for API clients and for the integration suite, and
  // carries no CSRF exposure because nothing attaches it automatically.
  const token =
    cookieFrom(request, ACCESS_COOKIE) ?? bearerTokenFrom(request.headers.get("authorization"));

  if (!token) {
    return errorResponse("UNAUTHENTICATED", "Sign in, or send a bearer access token.", requestId);
  }

  let claims: VerifiedClaims;

  try {
    claims = await verifyAccessToken(token);
  } catch (error: unknown) {
    if (error instanceof InvalidTokenError) {
      // The specific reason is deliberately not echoed back. "Which part of my
      // forged token was wrong" is not a question this endpoint should answer.
      return errorResponse("UNAUTHENTICATED", "The access token is not valid.", requestId);
    }

    throw error;
  }

  try {
    return await handler({ claims, accessToken: token, requestId });
  } catch (error: unknown) {
    // Nothing from an exception reaches the client. A database error message
    // can contain column names, constraint names and fragments of values.
    //
    // It does have to reach *somewhere*, though — a 500 with no trace anywhere
    // is undebuggable. The request id ties this line to the client's response.
    // Only the error's type and message are recorded: no stack, no claims, no
    // token, and nothing derived from a document.
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        event: "unhandled_request_error",
        requestId,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : "non-error thrown",
      })}\n`,
    );

    return errorResponse("INTERNAL_ERROR", "The request could not be completed.", requestId);
  }
}
