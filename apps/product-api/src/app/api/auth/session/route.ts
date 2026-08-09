import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  assertSameOrigin,
  clearedSessionCookies,
  cookieFrom,
  CrossSiteRequestError,
  REFRESH_COOKIE,
  sessionCookies,
} from "@/lib/auth/session";
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
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);

  return new Response(JSON.stringify(body), { status, headers });
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

/** Sign out. */
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

  // Revoke server-side as well as clearing the cookies. Clearing alone would
  // leave a live refresh token in anything that had already captured it — a
  // proxy log, a shared machine's browser profile — and "signed out" would mean
  // only that this browser had forgotten.
  if (refreshToken) {
    try {
      const client = anonClient();
      await client.auth.setSession({ access_token: "", refresh_token: refreshToken });
      await client.auth.signOut();
    } catch {
      // Best effort. A revocation that fails must not leave the user still
      // signed in locally, which is the outcome they asked for.
    }
  }

  return withCookies({ signedOut: true }, 200, clearedSessionCookies());
}
