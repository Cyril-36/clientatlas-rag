import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

/**
 * Next loads `.env` from the application directory, not from the workspace
 * root. This repository keeps one `.env` at the root so that the web app, the
 * migrator and the integration tests cannot drift onto different databases —
 * so it has to be loaded explicitly, here, before the server starts.
 *
 * Without this, `pnpm dev` starts cleanly and then fails at the first request
 * that needs a connection string, which is a confusing way to discover it.
 *
 * `loadEnvFile` does not overwrite variables that are already set, so a value
 * exported in the shell or injected by a platform still wins.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = path.join(repoRoot, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const nextConfig: NextConfig = {
  /**
   * Workspace packages are consumed as TypeScript source rather than built
   * output, so Next compiles them itself. This keeps the shared contracts a
   * single source of truth with no build step between editing and using them.
   */
  transpilePackages: ["@clientatlas/contracts", "@clientatlas/database"],
};

export default nextConfig;
