import { getServerEnv } from "@/lib/env";

/**
 * Browser sessions, held in cookies the page cannot read.
 *
 * The alternative — keeping Supabase tokens in `localStorage` and attaching
 * them as a bearer header — is the common pattern and the wrong one *here*
 * specifically. This product renders passages from documents its tenants
 * upload. Displaying untrusted third-party content is the surface where an XSS
 * eventually gets through, and any script that runs on the page can read
 * `localStorage`. A token in an `HttpOnly` cookie survives that bug; a token in
 * `localStorage` is exfiltrated by it.
 *
 * The cost is CSRF, because cookies are ambient authority: the browser attaches
 * them to a cross-site form post as readily as to our own fetch. That is paid
 * for below, and it is a bounded, well-understood cost with a known fix —
 * unlike token theft, which has no fix after the fact.
 *
 * Nothing about the authorization model changes. The cookie carries the same
 * Supabase access token the `Authorization` header used to; it is verified by
 * the same code, narrowed to the same claims, and handed to the same
 * transaction-local RLS contract. This is a different way to *carry* the
 * credential, not a second way to decide what it may do.
 */

export const ACCESS_COOKIE = "clientatlas_access";
export const REFRESH_COOKIE = "clientatlas_refresh";

/**
 * Refresh tokens are scoped to the one route that may exchange them.
 *
 * An access token is needed by every API route. A refresh token is needed by
 * exactly one, and it is the more dangerous of the two — it mints access
 * tokens. Scoping the path means the browser does not attach it to ordinary
 * requests at all, so it is not present to be leaked by a logging mistake or a
 * misdirected proxy on any other endpoint.
 */
export const REFRESH_COOKIE_PATH = "/api/auth/session";

export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires, as reported by Supabase. */
  readonly expiresIn: number;
}

function isSecureContext(): boolean {
  // `Secure` is required in production and impossible on plain-HTTP localhost,
  // where the browser silently drops the cookie and sign-in appears to succeed
  // and then does nothing. Keyed off NODE_ENV rather than the request, because
  // a request-derived answer can be influenced by a forwarded header.
  return process.env.NODE_ENV === "production";
}

function attributes(maxAgeSeconds: number, path: string): string {
  const parts = [
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    // Lax rather than Strict: Strict would drop the session cookie on any
    // inbound navigation from another site, so a user following a link to a
    // workspace would arrive signed out. Lax still withholds cookies from
    // cross-site POST, which is the case that matters.
    "SameSite=Lax",
  ];

  if (isSecureContext()) parts.push("Secure");

  return parts.join("; ");
}

export function sessionCookies(tokens: SessionTokens): string[] {
  return [
    `${ACCESS_COOKIE}=${tokens.accessToken}; ${attributes(tokens.expiresIn, "/")}`,
    // Thirty days, matching Supabase's default refresh-token lifetime. A
    // shorter cookie than the token it holds would sign people out while the
    // credential was still valid; a longer one would keep a dead token around.
    `${REFRESH_COOKIE}=${tokens.refreshToken}; ${attributes(60 * 60 * 24 * 30, REFRESH_COOKIE_PATH)}`,
  ];
}

export function clearedSessionCookies(): string[] {
  return [
    `${ACCESS_COOKIE}=; ${attributes(0, "/")}`,
    `${REFRESH_COOKIE}=; ${attributes(0, REFRESH_COOKIE_PATH)}`,
  ];
}

/**
 * Read one cookie from a request.
 *
 * Written by hand rather than reached for from `next/headers` so it can be
 * unit-tested against a plain `Request`, and so the parsing is visible: cookie
 * values here are JWTs, which contain `.` and `-` and `_` but never `;`.
 */
export function cookieFrom(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim() || null;
    }
  }

  return null;
}

export class CrossSiteRequestError extends Error {}

/**
 * Reject a state-changing request that did not originate from this site.
 *
 * `SameSite=Lax` already stops the browser attaching session cookies to a
 * cross-site POST, and this is deliberately a second lock on the same door:
 * SameSite is enforced by the browser, and a browser that is old, unusual or
 * being emulated is not something a security property should rest on alone.
 *
 * `Origin` is the check. It is sent on every cross-origin request and on
 * same-origin unsafe methods, it cannot be set by page script, and unlike
 * `Referer` it is not stripped by privacy tooling. A request with no `Origin`
 * at all is allowed only for safe methods — that covers a plain navigation,
 * and a non-browser client using a bearer token, which is not cookie-borne and
 * therefore not subject to CSRF in the first place.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const origin = request.headers.get("origin");

  // No Origin on an unsafe method means no browser sent it. Bearer-token
  // callers land here, and they carry no ambient credential to abuse.
  if (!origin) {
    if (cookieFrom(request, ACCESS_COOKIE)) {
      throw new CrossSiteRequestError("a cookie session requires an Origin header");
    }
    return;
  }

  const expected = allowedOrigins(request);

  if (!expected.has(origin)) {
    throw new CrossSiteRequestError(`origin ${origin} is not this site`);
  }
}

function allowedOrigins(request: Request): Set<string> {
  const allowed = new Set<string>();

  const configured = getServerEnv().APP_ORIGIN;
  if (configured) allowed.add(configured);

  // The request's own host, so a developer on a different port than the
  // configured one is not locked out. `Host` is attacker-influenceable behind a
  // careless proxy, which is why the configured origin exists and should be set
  // in any deployment that matters.
  const host = request.headers.get("host");
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }

  return allowed;
}
