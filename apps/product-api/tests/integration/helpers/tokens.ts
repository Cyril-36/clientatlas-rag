import process from "node:process";

import { SignJWT } from "jose";

/**
 * Mints access tokens shaped like Supabase's.
 *
 * Test-only, and deliberately outside `src/` so nothing in the application can
 * import a token minter by accident.
 */

interface MintOptions {
  readonly sub: string;
  readonly role?: string;
  readonly email?: string;
  readonly audience?: string;
  readonly expiresInSeconds?: number;
}

function secret(): Uint8Array {
  const value = process.env["SUPABASE_JWT_SECRET"];

  if (!value) {
    throw new Error("SUPABASE_JWT_SECRET is not set; the integration setup file should supply it.");
  }

  return new TextEncoder().encode(value);
}

export async function mintAccessToken(options: MintOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 3600;

  return new SignJWT({
    role: options.role ?? "authenticated",
    email: options.email ?? `${options.sub}@example.test`,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(options.sub)
    .setAudience(options.audience ?? "authenticated")
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(secret());
}
