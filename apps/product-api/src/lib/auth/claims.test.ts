import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidTokenError, verifyAccessToken } from "@/lib/auth/claims";
import { resetServerEnvForTests } from "@/lib/env";

/**
 * The verifier, tested against the tokens it must refuse.
 *
 * These are the cases that stay unit tests rather than moving to real Supabase
 * sign-in: a live stack will not issue a forged token, an `alg: none` token or
 * a `service_role` token on request, and those are precisely the ones whose
 * rejection matters. Positive-path coverage belongs in the integration suite,
 * against tokens Supabase actually minted.
 */

const SECRET = "a-symmetric-secret-of-at-least-32-characters";
const SUBJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ORIGINAL = { ...process.env };

function configureSymmetric(): void {
  process.env["RUNTIME_DATABASE_URL"] = "postgresql://runtime@127.0.0.1:5432/test";
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:54321";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon";
  process.env["SUPABASE_JWT_SECRET"] = SECRET;
  delete process.env["SUPABASE_JWKS_URL"];
  resetServerEnvForTests();
}

async function symmetricToken(claims: Record<string, unknown>, alg = "HS256"): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setAudience("authenticated")
    .sign(new TextEncoder().encode(SECRET));
}

beforeEach(configureSymmetric);

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetServerEnvForTests();
});

describe("verifyAccessToken", () => {
  it("accepts a well-formed token and narrows it", async () => {
    const token = await symmetricToken({ sub: SUBJECT, role: "authenticated", email: "a@b.test" });

    expect(await verifyAccessToken(token)).toEqual({
      sub: SUBJECT,
      role: "authenticated",
      email: "a@b.test",
    });
  });

  it("refuses a token signed with a different secret", async () => {
    const forged = await new SignJWT({ sub: SUBJECT, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .setAudience("authenticated")
      .sign(new TextEncoder().encode("a-completely-different-secret-value-here"));

    await expect(verifyAccessToken(forged)).rejects.toThrow(InvalidTokenError);
  });

  it("refuses an expired token", async () => {
    const expired = await new SignJWT({ sub: SUBJECT, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("-1h")
      .setAudience("authenticated")
      .sign(new TextEncoder().encode(SECRET));

    await expect(verifyAccessToken(expired)).rejects.toThrow(InvalidTokenError);
  });

  it("refuses a service_role token", async () => {
    // Supabase issues these and they bypass row-level security entirely. One
    // must never be accepted on a user request path, however it was obtained.
    const privileged = await symmetricToken({ sub: SUBJECT, role: "service_role" });

    await expect(verifyAccessToken(privileged)).rejects.toThrow(/service_role/);
  });

  it("refuses a subject that is not a UUID", async () => {
    // Policies cast `sub` to uuid; a non-UUID raises inside the policy rather
    // than matching nothing, which turns a bad token into a 500.
    const token = await symmetricToken({ sub: "not-a-uuid", role: "authenticated" });

    await expect(verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("refuses a token for another audience", async () => {
    const token = await new SignJWT({ sub: SUBJECT, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .setAudience("some-other-service")
      .sign(new TextEncoder().encode(SECRET));

    await expect(verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("refuses garbage that is not a token at all", async () => {
    await expect(verifyAccessToken("not.a.jwt")).rejects.toThrow(InvalidTokenError);
    await expect(verifyAccessToken("")).rejects.toThrow(InvalidTokenError);
  });
});

describe("algorithm pinning", () => {
  it("refuses an asymmetric token when a symmetric secret is configured", async () => {
    // The confusion case, stated concretely. With the accepted list spanning
    // both families, a verifier configured for one could be handed a token
    // signed by the other — and in the reverse direction, an attacker holding
    // only a *public* key can sign HS256 with it and a both-accepting verifier
    // checks that signature using the public key as an HMAC secret. Pinning to
    // the configured key material makes the whole class unreachable.
    const { privateKey } = await generateKeyPair("ES256");

    const token = await new SignJWT({ sub: SUBJECT, role: "authenticated" })
      .setProtectedHeader({ alg: "ES256" })
      .setExpirationTime("1h")
      .setAudience("authenticated")
      .sign(privateKey);

    await expect(verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("refuses a symmetric token when JWKS is configured", async () => {
    const { publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);

    // A JWKS URL that resolves, so the rejection is about the algorithm rather
    // than about failing to fetch keys.
    const body = JSON.stringify({ keys: [{ ...jwk, alg: "ES256", kid: "k1", use: "sig" }] });
    process.env["SUPABASE_JWKS_URL"] = `data:application/json;base64,${btoa(body)}`;
    delete process.env["SUPABASE_JWT_SECRET"];
    resetServerEnvForTests();

    const token = await symmetricToken({ sub: SUBJECT, role: "authenticated" });

    await expect(verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("refuses an unsigned token", async () => {
    // `alg: none` is the original JWT footgun. Rejected because the accepted
    // list never contains it, not because of a special case.
    const unsigned = `${btoa('{"alg":"none"}')}.${btoa(
      JSON.stringify({ sub: SUBJECT, role: "authenticated", aud: "authenticated" }),
    )}.`;

    await expect(verifyAccessToken(unsigned)).rejects.toThrow(InvalidTokenError);
  });
});
