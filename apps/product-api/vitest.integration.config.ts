import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Integration tests. These require a running PostgreSQL with the migrations
 * applied, and they are the tests that actually prove tenant isolation.
 *
 * They run single-threaded and in sequence: several of them assert on
 * database-wide state such as role attributes and RLS flags, which two parallel
 * workers would race on.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
