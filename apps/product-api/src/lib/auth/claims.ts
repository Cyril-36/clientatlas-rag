import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { getServerEnv } from "@/lib/env";

/**
 * The claims the database is told about.
 *
 * Deliberately a small, fixed shape rather than the raw token payload. Whatever
 * ends up here is written into `request.jwt.claims` and read by every RLS
 * policy, so it must contain only fields this application has verified and
 * understands. Passing the payload through verbatim would let a token author
 * introduce arbitrary keys into a security-critical setting.
 */
export interface VerifiedClaims {
  readonly sub: string;
  readonly role: "authenticated";
  readonly email: string | null;
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let remoteJwks: JWTVerifyGetKey | undefined;

interface Verifier {
  readonly key: Uint8Array | JWTVerifyGetKey;
  /**
   * Only the algorithms the configured key material can actually verify.
   *
   * Listing all three regardless — which this did — is the classic JWT
   * confusion setup in miniature. A symmetric secret is bytes; an attacker who
   * learns the *public* half of an asymmetric pair can sign `HS256` with it and
   * a verifier that accepts both families will happily check that signature
   * using the public key as an HMAC secret. Neither key type here can be
   * abused that way if the accepted list never spans both.
   */
  readonly algorithms: string[];
}

function getVerifier(): Verifier {
  const env = getServerEnv();

  if (env.SUPABASE_JWT_SECRET) {
    return {
      key: new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      algorithms: ["HS256"],
    };
  }

  if (!env.SUPABASE_JWKS_URL) {
    throw new Error("No JWT key material configured.");
  }

  remoteJwks ??= createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));
  return { key: remoteJwks, algorithms: ["ES256", "RS256"] };
}

/**
 * Cryptographically verifies an access token and narrows it to the claims the
 * database is allowed to see.
 *
 * Signature and expiry are checked by `jwtVerify`. The checks after it are the
 * ones that matter for tenancy:
 *
 *  - `sub` must be a UUID, because every policy casts it to `uuid`. A non-UUID
 *    subject would raise inside a policy rather than simply match nothing.
 *  - `role` must be exactly `authenticated`. Supabase also issues `service_role`
 *    tokens, which bypass row-level security entirely; one must never be
 *    accepted on a user request path.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedClaims> {
  const env = getServerEnv();

  if (!token) {
    throw new InvalidTokenError("Missing access token.");
  }

  let payload;

  try {
    const verifier = getVerifier();

    const result = await jwtVerify(token, verifier.key, {
      audience: env.SUPABASE_JWT_AUDIENCE,
      ...(env.SUPABASE_JWT_ISSUER ? { issuer: env.SUPABASE_JWT_ISSUER } : {}),
      algorithms: verifier.algorithms,
    });
    payload = result.payload;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "verification failed";
    throw new InvalidTokenError(`Access token rejected: ${reason}`);
  }

  const sub = payload.sub;

  if (typeof sub !== "string" || !UUID_PATTERN.test(sub)) {
    throw new InvalidTokenError("Access token subject is not a UUID.");
  }

  const role = payload["role"];

  if (role !== "authenticated") {
    throw new InvalidTokenError(
      `Access token role is '${String(role)}', expected 'authenticated'. ` +
        "Tokens for privileged roles are never accepted on a user request path.",
    );
  }

  const email = payload["email"];

  return {
    sub,
    role: "authenticated",
    email: typeof email === "string" ? email : null,
  };
}

/** Extracts a bearer token from an Authorization header. */
export function bearerTokenFrom(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !value) {
    return null;
  }

  return value;
}
