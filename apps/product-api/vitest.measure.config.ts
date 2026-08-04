import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Retrieval measurement, deliberately outside the integration run.
 *
 * Five integration suites call `truncateTenantTables()`, which truncates
 * `organizations ... cascade` and therefore destroys any seeded evaluation
 * corpus. When the measurement lived alongside them it could run against a
 * table another suite had already emptied, where `hybrid >= vector` becomes
 * `0 >= 0` and a cross-tenant assertion of `[]` passes for entirely the wrong
 * reason. Both green, both meaningless.
 *
 * Keeping it in its own run is the fix: nothing here truncates, and nothing
 * that truncates runs here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/measure/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
