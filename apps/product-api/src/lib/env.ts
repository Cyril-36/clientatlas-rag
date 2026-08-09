import process from "node:process";

import { z } from "zod";

/**
 * Server-side environment.
 *
 * Parsed once, on first access, and never re-read. Nothing here has a default
 * that points at a database or an external service: a missing value must stop
 * the process, not silently connect somewhere unintended.
 */
/**
 * An unset variable in a .env file is an empty string, not an absent key.
 * Without this, a commented-out placeholder like `SUPABASE_JWKS_URL=` would be
 * read as "configured, but invalid" rather than "not configured".
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const serverEnvSchema = z
  .object({
    CLIENTATLAS_MODE: z.enum(["local", "demo"]).default("local"),

    /**
     * The connection the application serves requests on. Must be
     * `clientatlas_runtime`: NOINHERIT and NOBYPASSRLS, so it holds no table
     * privileges until the claims helper assumes the `authenticated` role.
     */
    RUNTIME_DATABASE_URL: z.string().min(1),

    /**
     * Supabase signs access tokens with a project secret (HS256) or an
     * asymmetric key published as a JWKS. Exactly one must be configured —
     * accepting both would mean a token signed either way is valid, which is a
     * larger surface than intended.
     */
    SUPABASE_JWT_SECRET: optional(z.string().min(32)),
    SUPABASE_JWKS_URL: optional(z.string().url()),

    SUPABASE_JWT_ISSUER: optional(z.string().min(1)),
    SUPABASE_JWT_AUDIENCE: z.string().min(1).default("authenticated"),

    /**
     * The model service. It holds no database access, so this is the only path
     * by which tenant content reaches it — which is the reason it defaults to
     * loopback rather than to nothing: a misconfiguration should fail to
     * connect locally, not quietly point somewhere else.
     */
    AI_SERVICE_URL: z.string().url().default("http://127.0.0.1:8000"),

    /**
     * Supabase Auth, used by the sign-in route to exchange a password for
     * tokens and to refresh them. Public values: the anon key is meant to be
     * shipped to browsers, and here it never leaves the server anyway.
     */
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),

    /**
     * This site's own origin, used to reject cross-site state-changing
     * requests. Optional because the request's own Host covers local
     * development; set it in any deployment behind a proxy, where Host is
     * attacker-influenceable and should not be the only answer.
     */
    APP_ORIGIN: optional(z.string().url()),
  })
  .refine((env) => Boolean(env.SUPABASE_JWT_SECRET) !== Boolean(env.SUPABASE_JWKS_URL), {
    message:
      "Configure exactly one of SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL. " +
      "Configuring both would accept tokens signed either way.",
    path: ["SUPABASE_JWT_SECRET"],
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) {
    return cached;
  }

  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    // Field names only. The values are secrets and must not reach a log line.
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid server environment. Check: ${fields}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: discard the memoised environment after mutating process.env. */
export function resetServerEnvForTests(): void {
  cached = undefined;
}
