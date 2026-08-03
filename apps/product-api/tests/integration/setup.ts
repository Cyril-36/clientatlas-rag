import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Loads the repository-root .env so integration tests see the same connection
 * strings the applications do.
 *
 * A test JWT secret is supplied when none is configured. Tests mint their own
 * tokens, so the value only has to be consistent within the run — but it must
 * exist, because the environment schema refuses to start without key material.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const envFile = path.join(repoRoot, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

process.env["SUPABASE_JWT_SECRET"] ??= "integration-test-secret-not-used-anywhere-else-0123456789";
delete process.env["SUPABASE_JWKS_URL"];
