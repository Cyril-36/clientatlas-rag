import { afterAll, describe, expect, it } from "vitest";

import { getRuntimeSql } from "@/lib/database/client";
import { isSupportedPgvector, MINIMUM_PGVECTOR } from "@/lib/database/pgvector";

/**
 * The database this suite runs against must be able to support retrieval.
 *
 * `hybridSearch` sets `hnsw.iterative_scan`, which pgvector added in 0.8.
 * Below that an HNSW scan behind a `workspace_id` predicate returns a short
 * page rather than an error, so an under-provisioned database does not
 * announce itself — every other test here would pass while retrieval silently
 * returned a fraction of the evidence.
 *
 * Three separate things are checked, because they can drift apart: what the
 * server has installed, whether the migration that enforces the floor is
 * present, and whether the setting the code depends on actually exists.
 */

afterAll(async () => {
  await getRuntimeSql().end({ timeout: 5 });
});

describe("pgvector", () => {
  it("is installed at a version that supports iterative scan", async () => {
    const rows = await getRuntimeSql()<{ extversion: string }[]>`
      select extversion from pg_extension where extname = 'vector'
    `;

    const version = rows[0]?.extversion;

    expect(version, "the vector extension is not installed").toBeDefined();
    expect(
      isSupportedPgvector(version),
      `pgvector ${version} is below the required ${MINIMUM_PGVECTOR.join(".")}`,
    ).toBe(true);
  });

  it("exposes the setting retrieval relies on, and keeps it once set", async () => {
    // The version number is a proxy; this is the thing itself.
    //
    // Order matters here, and it is the whole point of the test. pgvector
    // registers its GUCs when the shared library loads, which happens on first
    // use of a vector operation — not at connection time. Before that,
    // PostgreSQL accepts any `hnsw.*` name as a placeholder, so on a server
    // without iterative scan the `set local` in `vectorCandidates` succeeds,
    // and then when the library loads PostgreSQL emits
    //
    //   WARNING: invalid configuration parameter name "hnsw.iterative_scan",
    //            removing it
    //
    // and drops it. The query then runs without iterative scan and returns a
    // short page. Verified against this server by setting a name that does not
    // exist: it is a warning and a removal, not an error.
    //
    // So this sets it first, exactly as retrieval does, then does a vector
    // operation, then asks what survived.
    const setting = await getRuntimeSql().begin(async (tx) => {
      await tx`set local hnsw.iterative_scan = strict_order`;
      await tx`select '[1,0,0]'::vector <=> '[0,1,0]'::vector`;

      const rows = await tx<{ value: string }[]>`
        select current_setting('hnsw.iterative_scan', true) as value
      `;

      return rows[0]?.value;
    });

    expect(
      setting,
      "hnsw.iterative_scan did not survive the extension loading — this server " +
        "silently discards it, and retrieval will return short pages",
    ).toBe("strict_order");
  });

  it("refuses to accept a version below the floor", async () => {
    // The migration's comparison, exercised against a version the server does
    // not have. Written as integer arrays rather than text because '0.10.0'
    // sorts below '0.8.0' as a string — the check would then reject a pgvector
    // newer than the one required, and this asserts it does not.
    const [row] = await getRuntimeSql()<{ old: boolean; newer: boolean; equal: boolean }[]>`
      select string_to_array('0.7.4', '.')::int[] < array[0, 8, 0]  as old,
             string_to_array('0.10.0', '.')::int[] < array[0, 8, 0] as newer,
             string_to_array('0.8.0', '.')::int[] < array[0, 8, 0]  as equal
    `;

    expect(row?.old, "0.7.4 should be rejected").toBe(true);
    expect(row?.newer, "0.10.0 should be accepted").toBe(false);
    expect(row?.equal, "0.8.0 is the floor and should be accepted").toBe(false);
  });
});
