import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACCESS_COOKIE,
  assertSameOrigin,
  clearedSessionCookies,
  cookieFrom,
  CrossSiteRequestError,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  sessionCookies,
} from "@/lib/auth/session";
import { resetServerEnvForTests } from "@/lib/env";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  // The whole validated environment, because `assertSameOrigin` reads the
  // configured origin through it. Set here rather than reaching around the
  // schema with a bare `process.env` lookup: the check decides whether a
  // state-changing request is allowed, and it should read the same
  // configuration every other part of the application does.
  process.env["RUNTIME_DATABASE_URL"] = "postgresql://runtime@127.0.0.1:5432/test";
  process.env["SUPABASE_JWT_SECRET"] = "a".repeat(40);
  delete process.env["SUPABASE_JWKS_URL"];
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:54321";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon-key-for-tests";
  process.env["APP_ORIGIN"] = "https://clientatlas.example";
  resetServerEnvForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetServerEnvForTests();
});

function requestWith(init: {
  method?: string;
  origin?: string;
  cookie?: string;
  host?: string;
}): Request {
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  if (init.cookie) headers.set("cookie", init.cookie);
  headers.set("host", init.host ?? "clientatlas.example");

  return new Request("https://clientatlas.example/api/workspaces/x/answers", {
    method: init.method ?? "POST",
    headers,
  });
}

describe("session cookies", () => {
  const tokens = {
    accessToken: "access.jwt.value",
    refreshToken: "refresh-value",
    expiresIn: 3600,
  };

  it("makes the tokens unreadable to page scripts", () => {
    // The entire reason for this design. A product that renders text from
    // uploaded documents will eventually run someone else's script; HttpOnly is
    // what stops that script walking off with the session.
    for (const cookie of sessionCookies(tokens)) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
    }
  });

  it("scopes the refresh token to the one route that may exchange it", () => {
    // The refresh token mints access tokens, so it is the more dangerous of the
    // two. Path-scoping means the browser does not attach it to ordinary API
    // requests, so it is not there to be captured by a logging mistake.
    const [access, refresh] = sessionCookies(tokens);

    expect(access).toContain("Path=/");
    expect(refresh).toContain(`Path=${REFRESH_COOKIE_PATH}`);
  });

  it("expires both cookies on sign-out", () => {
    for (const cookie of clearedSessionCookies()) {
      expect(cookie).toContain("Max-Age=0");
    }
  });

  it("clears the refresh cookie on the same path it was set", () => {
    // A clearing cookie written at a different path does not replace the
    // original: the browser keeps both, and the session survives a sign-out.
    const cleared = clearedSessionCookies().find((cookie) => cookie.startsWith(REFRESH_COOKIE));

    expect(cleared).toContain(`Path=${REFRESH_COOKIE_PATH}`);
  });
});

describe("cookieFrom", () => {
  it("reads a JWT, which contains dots, dashes and underscores", () => {
    const jwt = "eyJhbG.eyJzdWIi_x-y.sig-nature_z";

    expect(cookieFrom(requestWith({ cookie: `${ACCESS_COOKIE}=${jwt}` }), ACCESS_COOKIE)).toBe(jwt);
  });

  it("picks the right cookie out of several", () => {
    const request = requestWith({
      cookie: `other=1; ${ACCESS_COOKIE}=wanted; ${REFRESH_COOKIE}=refresh`,
    });

    expect(cookieFrom(request, ACCESS_COOKIE)).toBe("wanted");
    expect(cookieFrom(request, REFRESH_COOKIE)).toBe("refresh");
  });

  it("does not match a cookie whose name merely ends with the one asked for", () => {
    // `evil_clientatlas_access` must not answer for `clientatlas_access`.
    const request = requestWith({ cookie: `evil_${ACCESS_COOKIE}=attacker` });

    expect(cookieFrom(request, ACCESS_COOKIE)).toBeNull();
  });

  it("returns null for an absent cookie header", () => {
    expect(cookieFrom(requestWith({}), ACCESS_COOKIE)).toBeNull();
  });
});

describe("assertSameOrigin", () => {
  it("allows a state-changing request from this site", () => {
    expect(() =>
      assertSameOrigin(
        requestWith({ origin: "https://clientatlas.example", cookie: `${ACCESS_COOKIE}=t` }),
      ),
    ).not.toThrow();
  });

  it("rejects a state-changing request from another site", () => {
    // The CSRF case: a form on evil.example posting to us while the browser
    // helpfully attaches the session cookie.
    expect(() =>
      assertSameOrigin(
        requestWith({ origin: "https://evil.example", cookie: `${ACCESS_COOKIE}=t` }),
      ),
    ).toThrow(CrossSiteRequestError);
  });

  it("rejects a cookie-bearing unsafe request with no Origin at all", () => {
    // Stripping the header must not be a way around the check.
    expect(() => assertSameOrigin(requestWith({ cookie: `${ACCESS_COOKIE}=t` }))).toThrow(
      CrossSiteRequestError,
    );
  });

  it("allows a bearer-token client that sends no Origin", () => {
    // Non-browser callers carry no ambient credential, so there is nothing for
    // a third-party site to abuse. Requiring Origin of them would break every
    // API client and buy no safety.
    expect(() => assertSameOrigin(requestWith({}))).not.toThrow();
  });

  it("allows safe methods regardless of origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(() =>
        assertSameOrigin(requestWith({ method, origin: "https://evil.example" })),
      ).not.toThrow();
    }
  });

  it("does not accept an origin that merely starts with ours", () => {
    // `https://clientatlas.example.evil.test` is a different site.
    expect(() =>
      assertSameOrigin(requestWith({ origin: "https://clientatlas.example.evil.test" })),
    ).toThrow(CrossSiteRequestError);
  });
});

describe("assertSameOrigin with APP_ORIGIN configured", () => {
  it("ignores the request's Host once an origin is configured", () => {
    // The point of the setting. `Host` is attacker-controlled behind a careless
    // proxy, so accepting it *alongside* an explicit configuration made the
    // configuration decorative — a deployment that had declared its origin
    // still trusted whatever a forged header claimed.
    const request = new Request("https://clientatlas.example/api/x", {
      method: "POST",
      headers: { origin: "https://attacker.test", host: "attacker.test" },
    });

    expect(() => assertSameOrigin(request)).toThrow(CrossSiteRequestError);
  });

  it("falls back to the request's Host when no origin is configured", () => {
    // Development, where ports move and there is no proxy to lie about them.
    delete process.env["APP_ORIGIN"];
    resetServerEnvForTests();

    const request = new Request("http://localhost:3001/api/x", {
      method: "POST",
      headers: { origin: "http://localhost:3001", host: "localhost:3001" },
    });

    expect(() => assertSameOrigin(request)).not.toThrow();
  });
});
