import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { defineConfig } from "@playwright/test";

// The test process needs the local stack's credentials too, not just the server
// it starts: the fixtures create real Supabase users and write real rows. Next
// loads .env for the app; nothing loads it for Playwright.
const repo = path.resolve(__dirname, "../..");

if (existsSync(path.join(repo, ".env"))) {
  process.loadEnvFile(path.join(repo, ".env"));
}

/**
 * Browser tests, run against a JWKS-configured server.
 *
 * The integration suite mints HS256 tokens by hand — that is how it produces
 * expired, forged and wrong-role tokens a real Supabase would never issue — and
 * the verifier accepts exactly one key family at a time. Those two facts do not
 * conflict, they just cannot share a process: this config starts its own server
 * with `SUPABASE_JWKS_URL` set, signs in through real Supabase Auth, and leaves
 * the hand-minted fixtures to the suite that needs them.
 *
 * Nothing here mints a token. Everything goes through the browser and the
 * cookies it is given, which is the only way to test a session design whose
 * whole point is that the page cannot touch the credential.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Serial. The tests sign users in and out of a shared local stack, and a
  // parallel run would have one test's sign-out revoking another's session.
  workers: 1,
  fullyParallel: false,
  // An answer runs an 8B model on CPU in CI. The generous timeout is the model,
  // not slow assertions.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    // Kept on the first retry rather than always: a green run should not
    // produce artefacts nobody reads, and a failure should leave everything
    // needed to understand it without being reproduced.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  retries: process.env["CI"] ? 1 : 0,
  webServer: {
    // A production build, not `next dev`. Dev mode is what ships to nobody: it
    // hydrates through an HMR websocket that these tests do not need and that
    // failed to connect under Playwright, leaving the page mounted but never
    // interactive. A built server is also what CI should be exercising.
    command: "pnpm run start:e2e",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: !process.env["CI"],
    timeout: 300_000,
    env: {
      // The reason this config exists. Current Supabase stacks issue ES256, so
      // a browser signing in for real needs the JWKS verifier.
      SUPABASE_JWKS_URL: "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
      SUPABASE_JWT_SECRET: "",
      APP_ORIGIN: "http://127.0.0.1:3100",
    },
  },
});
