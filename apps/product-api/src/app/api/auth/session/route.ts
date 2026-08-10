import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  ACCESS_COOKIE,
  assertSameOrigin,
  clearedSessionCookies,
  cookieFrom,
  CrossSiteRequestError,
  REFRESH_COOKIE,
  sessionCookies,
} from "@/lib/auth/session";
import { InvalidTokenError, verifyAccessToken } from "@/lib/auth/claims";
import { getServerEnv } from "@/lib/env";
import { errorResponse } from "@/lib/http/responses";

/**
 * The session endpoint: the only place a password or a refresh token is
 * handled, and the only place `Set-Cookie` is written.
 *
 * This is a backend-for-frontend, so the browser never holds a Supabase token
 * in reachable storage. It posts a password here, gets back cookies it cannot
 * read, and every subsequent request carries them automatically.
 *
 * `POST` signs in, `PUT` refreshes, `DELETE` signs out. All three are
 * state-changing and all three go through the same-origin check.
 */

export const dynamic = "force-dynamic";

function anonClient() {
  const env = getServerEnv();

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    // The server holds no session of its own. Each call is a single exchange,
    // and persisting one here would be a shared mutable session across every
    // user of the process.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function withCookies(body: unknown, status: number, cookies: string[]): Response {
  const headers = new Headers({
    "content-type": "application/json",
    // Never stored, never revalidated from a cache. These responses carry
    // `Set-Cookie` and identity; a shared cache holding one would hand the next
    // person the previous person's session.
    "cache-control": "no-store",
  });

  for (const cookie of cookies) headers.append("set-cookie", cookie);

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Check a token this application will accept before writing it into a cookie.
 *
 * Supabase issued it a moment ago, so this is not distrust of Supabase — it is
 * a check that its tokens are ones *this* deployment can verify. A stack whose
 * signing algorithm does not match the configured verifier hands back a
 * perfectly valid token that every later request rejects, and the symptom is a
 * sign-in that appears to succeed followed by a 401 on the next call. Failing
 * here says what is actually wrong, once, instead of leaving a browser holding
 * cookies it can never use.
 */
async function usableHere(accessToken: string): Promise<boolean> {
  try {
    await verifyAccessToken(accessToken);
    return true;
  } catch (error) {
    if (error instanceof InvalidTokenError) return false;
    throw error;
  }
}

/** Sign in with a password. */
export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CrossSiteRequestError) {
      return errorResponse("FORBIDDEN", "Cross-site request rejected.", requestId);
    }
    throw error;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse("VALIDATION_FAILED", "Body must be JSON.", requestId);
  }

  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return errorResponse("VALIDATION_FAILED", "An email and password are required.", requestId);
  }

  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });

  // Deliberately one message for every failure. "No such user" and "wrong
  // password" are different facts, and telling them apart is how an address
  // list gets confirmed.
  if (error || !data.session) {
    return errorResponse("UNAUTHENTICATED", "Those credentials were not accepted.", requestId);
  }

  if (!(await usableHere(data.session.access_token))) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Signed in, but this deployment cannot verify the token Supabase issued. " +
        "Check that SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET matches the project's signing keys.",
      requestId,
    );
  }

  return withCookies(
    // The tokens are not in this body, on purpose. The browser has them in
    // cookies it cannot read; returning them as JSON would put them back within
    // reach of any script on the page and undo the point of the design.
    { user: { id: data.user?.id ?? null, email: data.user?.email ?? null } },
    200,
    sessionCookies({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in ?? 3600,
    }),
  );
}

/**
 * Who, if anyone, is signed in.
 *
 * The page cannot read the session cookie, so on load it has no way to know
 * whether it is signed in — without this it showed the sign-in form to someone
 * holding a perfectly good session, and a reload looked like a logout. Safe
 * method, so no origin check: it reveals nothing a cookie holder does not
 * already have.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const accessToken = cookieFrom(request, ACCESS_COOKIE);

  const headers = { "cache-control": "no-store", "content-type": "application/json" };

  if (!accessToken) {
    return new Response(JSON.stringify({ signedIn: false }), { status: 200, headers });
  }

  try {
    const claims = await verifyAccessToken(accessToken);

    return new Response(
      JSON.stringify({ signedIn: true, user: { id: claims.sub, email: claims.email } }),
      { status: 200, headers },
    );
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      // Expired or otherwise unusable. Reported as not signed in rather than as
      // an error: the caller's next move is to refresh, and it can tell the
      // difference by whether a refresh cookie is still present.
      return new Response(JSON.stringify({ signedIn: false, requestId }), { status: 200, headers });
    }
    throw error;
  }
}

/** Exchange the refresh cookie for a fresh access token. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = randomUUID();

  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CrossSiteRequestError) {
      return errorResponse("FORBIDDEN", "Cross-site request rejected.", requestId);
    }
    throw error;
  }

  const refreshToken = cookieFrom(request, REFRESH_COOKIE);

  if (!refreshToken) {
    return errorResponse("UNAUTHENTICATED", "No session to refresh.", requestId);
  }

  const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });

  if (error || !data.session) {
    // A refresh token that no longer works means the session is over. Clearing
    // the cookies here stops the browser retrying with a credential that will
    // never succeed again.
    return withCookies(
      { code: "UNAUTHENTICATED", message: "The session has expired.", requestId },
      401,
      clearedSessionCookies(),
    );
  }

  return withCookies(
    { user: { id: data.user?.id ?? null, email: data.user?.email ?? null } },
    200,
    sessionCookies({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in ?? 3600,
    }),
  );
}

/**
 * Sign out, and mean it.
 *
 * The first version of this called `setSession({ access_token: "", ... })` and
 * then `signOut()`. Supabase answers the first with `AuthSessionMissingError`,
 * the error was discarded, and the second had no session to revoke — so the
 * cookies were cleared and the refresh token stayed valid for thirty days.
 * Anything that had already captured it, a proxy log or a shared machine, could
 * keep minting access tokens against an account whose owner believed they had
 * signed out.
 *
 * Revocation needs a live access token, so an expired one is refreshed first.
 * `scope: "local"` ends this session only: signing out on a laptop should not
 * evict the same person from their phone.
 */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = randomUUID();

  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CrossSiteRequestError) {
      return errorResponse("FORBIDDEN", "Cross-site request rejected.", requestId);
    }
    throw error;
  }

  const refreshToken = cookieFrom(request, REFRESH_COOKIE);
  const accessToken = cookieFrom(request, ACCESS_COOKIE);

  let revoked = false;

  if (refreshToken) {
    revoked = await revokeSession(accessToken, refreshToken);
  }

  // The cookies are cleared either way. A failed revocation must not leave
  // someone signed in locally — that is the one outcome they explicitly asked
  // for — but it is reported rather than swallowed, because "signed out" and
  // "signed out here, still valid elsewhere" are different facts.
  return withCookies({ signedOut: true, revoked }, 200, clearedSessionCookies());
}

/** Returns whether Supabase actually accepted the revocation. */
async function revokeSession(accessToken: string | null, refreshToken: string): Promise<boolean> {
  const client = anonClient();

  let usable = accessToken;

  // An expired access token cannot authorise its own revocation, and an expired
  // session is exactly when someone reaches for sign-out. Exchange the refresh
  // token for a live one first; the pair that comes back is what gets revoked.
  if (!usable || isExpired(usable)) {
    const refreshed = await client.auth.refreshSession({ refresh_token: refreshToken });

    if (refreshed.error || !refreshed.data.session) return false;

    usable = refreshed.data.session.access_token;
    refreshToken = refreshed.data.session.refresh_token;
  }

  const applied = await client.auth.setSession({
    access_token: usable,
    refresh_token: refreshToken,
  });

  if (applied.error) return false;

  const { error } = await client.auth.signOut({ scope: "local" });

  return !error;
}

/**
 * Is this access token past its expiry?
 *
 * Read without verifying, deliberately: the question is only whether it is
 * worth *attempting* a revocation with it, and a token that fails verification
 * will be rejected by Supabase anyway. Nothing here grants access on the
 * strength of the answer.
 */
function isExpired(token: string): boolean {
  const [, payload] = token.split(".");
  if (!payload) return true;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
      exp?: number;
    };

    if (typeof decoded.exp !== "number") return true;

    // A few seconds of margin, so a token about to expire mid-flight is
    // refreshed rather than used and rejected.
    return decoded.exp * 1000 <= Date.now() + 5_000;
  } catch {
    return true;
  }
}
