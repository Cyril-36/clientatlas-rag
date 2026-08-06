import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import process from "node:process";

import postgres from "postgres";
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
 * Three separate things, because they drift apart: what the server has
 * installed, whether the migrations that enforce that are actually applied to
 * this database, and whether the setting the code depends on behaves.
 *
 * The middle one was claimed before it was checked. An earlier version of this
 * file said it verified "migration presence" while only evaluating the
 * comparison expression against literals — which a database that had never run
 * the migration passes happily, and one did: the local stack had been started
 * before the file existed and carried no record of it.
 */

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../supabase/migrations",
);

/**
 * A connection as `clientatlas_test`, which is the only role granted read
 * access to `supabase_migrations.schema_migrations` — see `supabase/seed.sql`.
 *
 * The runtime role deliberately cannot see it, and that is not an obstacle to
 * work around: nothing a request does has any business knowing which
 * migrations exist. Asking with the runtime credential is how the first
 * attempt at this test failed, and the right answer was to ask as the role
 * whose whole purpose is to inspect the database under test.
 */
function migrationSql(): ReturnType<typeof postgres> {
  const url = process.env["TEST_DATABASE_URL"];

  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set; it carries the clientatlas_test credential");
  }

  return postgres(url, { max: 1, onnotice: () => {} });
}

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

  it("has every migration in the repository actually applied", async () => {
    // Written against the directory rather than against one version string, so
    // the next migration added is covered without anyone remembering to come
    // back here. The failure this catches is a database that predates a
    // migration file — which is what "it works on my machine" looks like when
    // the machine was set up before the guard was written.
    const expected = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0]!)
      .sort();

    expect(expected.length, `no migrations found in ${MIGRATIONS}`).toBeGreaterThan(0);

    const sql = migrationSql();
    const rows = await sql<{ version: string }[]>`
      select version from supabase_migrations.schema_migrations
    `.finally(() => sql.end({ timeout: 5 }));

    const applied = new Set(rows.map((row) => row.version));
    const missing = expected.filter((version) => !applied.has(version));

    expect(
      missing,
      `migrations present in the repository but not applied to this database: ${missing.join(", ")}. ` +
        "Run `supabase migration up` (or `supabase db reset` for a clean rebuild).",
    ).toEqual([]);
  });

  it("has the pgvector floor enforced by an applied migration, not just by a file", async () => {
    // The specific one this suite exists for, named rather than counted, so a
    // failure says which guarantee is missing rather than that a number moved.
    const sql = migrationSql();
    const rows = await sql<{ name: string }[]>`
      select name from supabase_migrations.schema_migrations
      where version = '20260805000000'
    `.finally(() => sql.end({ timeout: 5 }));

    expect(
      rows[0]?.name,
      "the pgvector minimum-version migration has never run against this database, " +
        "so nothing here has actually rejected an old pgvector",
    ).toBe("clientatlas_pgvector_minimum");
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
