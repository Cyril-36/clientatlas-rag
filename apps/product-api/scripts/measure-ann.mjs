import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/**
 * How much does approximate nearest-neighbour search cost us, and does
 * iterative scan buy it back?
 *
 *     pnpm --filter @clientatlas/product-api exec node scripts/measure-ann.mjs gitlab-handbook-v1
 *
 * This is a different question from the recall measurement in tests/measure.
 * That one asks whether retrieval finds the passage a human labelled; this one
 * asks whether the index returns the same rows an exact scan would. They can
 * move in opposite directions — an approximate index that drops a chunk the
 * labeller did not care about costs nothing — so the two numbers are kept
 * apart. Only this one is a property of the index.
 *
 * The problem being measured. `document_chunks` holds every tenant's rows, and
 * a query carries `where workspace_id = $1`. PostgreSQL can satisfy that by
 * walking the workspace btree and sorting distances exactly, which is right but
 * linear in the tenant's chunk count, or by walking the HNSW index in distance
 * order and discarding rows belonging to other tenants. The second is the only
 * one that stays fast as a corpus grows, and by default it stops after
 * `ef_search` candidates whether or not any of them survived the filter — so a
 * small tenant in a large table can get back fewer rows than it asked for, and
 * no error.
 *
 * pgvector 0.8 added iterative scan: keep pulling candidates until `limit` rows
 * pass the filter, capped by `hnsw.max_scan_tuples`. `strict_order` returns
 * them in exact distance order; `relaxed_order` allows a cheaper, slightly
 * out-of-order result.
 *
 * Ground truth here is an exact scan, taken by disabling index scans for the
 * comparison query only.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

if (existsSync(path.join(REPO, ".env"))) {
  process.loadEnvFile(path.join(REPO, ".env"));
}

const dataset = process.argv[2] ?? "gitlab-handbook-v1";
const seedPath = path.join(REPO, "evals", "reports", `${dataset}-seed.json`);

if (!existsSync(seedPath)) {
  process.stderr.write(`no seed at ${seedPath}\nload the corpus first\n`);
  process.exit(2);
}

const url = process.env["TEST_DATABASE_URL"];

if (!url) {
  process.stderr.write("TEST_DATABASE_URL is not set\n");
  process.exit(2);
}

const seed = JSON.parse(readFileSync(seedPath, "utf-8"));
const sql = postgres(url, { max: 1, onnotice: () => {} });

const LIMIT = 20;

/**
 * ids the query returns, in order, under the given session settings.
 *
 * `documents` narrows the query to a subset of the tenant's documents. That is
 * a stand-in for a smaller tenant, and it is the honest way to reach one
 * without writing rows: what determines whether the default HNSW scan comes up
 * short is the share of the table that survives the filter, not what the filter
 * is about. A tenant holding 1% of `document_chunks` and a document subset
 * holding 1% put the same pressure on the index.
 */
async function ids(embedding, settings, documents) {
  return sql.begin(async (tx) => {
    for (const [name, value] of Object.entries(settings)) {
      await tx.unsafe(`set local ${name} = ${value}`);
    }

    // EXPLAIN here, in the transaction that runs the query, rather than in a
    // separate one. The planner decides per execution and has been observed
    // deciding differently on consecutive runs over unchanged data, so a plan
    // sampled elsewhere can disagree with the rows it is printed beside — an
    // earlier version of this script reported "exact" next to an agreement of
    // 0.97, which is not something an exact scan can produce.
    const explained = await tx`
      explain select c.id
      from document_chunks c join documents d on d.id = c.document_id
      where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
        and c.embedding is not null
        ${documents ? sql`and c.document_id = any(${documents}::uuid[])` : sql``}
      order by c.embedding <=> ${JSON.stringify(embedding)}::vector, d.title, c.ordinal
      limit ${LIMIT}
    `;

    const plan = explained
      .map((r) => Object.values(r)[0])
      .join("\n")
      .includes("embedding_idx")
      ? "HNSW"
      : "exact";

    const started = process.hrtime.bigint();
    const rows = await tx`
      select c.id
      from document_chunks c join documents d on d.id = c.document_id
      where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
        and c.embedding is not null
        ${documents ? sql`and c.document_id = any(${documents}::uuid[])` : sql``}
      order by c.embedding <=> ${JSON.stringify(embedding)}::vector, d.title, c.ordinal
      limit ${LIMIT}
    `;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    return { ids: rows.map((r) => r.id), ms, plan };
  });
}

/** "HNSW", "exact", or "HNSW/exact" when the planner did not stay consistent. */
function summarise(plans) {
  return [...new Set(plans)].sort().join("/");
}

// Ground truth: no index scan, so the sort is over every row of the tenant.
const EXACT = { enable_indexscan: "off", enable_bitmapscan: "off" };

const variants = {
  "hnsw (default)": {},
  "hnsw + iterative strict": { "hnsw.iterative_scan": "strict_order" },
  "hnsw + iterative relaxed": { "hnsw.iterative_scan": "relaxed_order" },
};

try {
  await sql`analyze document_chunks`;

  const [{ total, tenants }] = await sql`
    select count(*)::int as total, count(distinct workspace_id)::int as tenants
    from document_chunks
  `;
  const [{ mine }] = await sql`
    select count(*)::int as mine from document_chunks where workspace_id = ${seed.workspaceId}
  `;

  process.stdout.write(
    `\n${total} rows across ${tenants} workspace(s); ${mine} in the workspace queried\n` +
      `${seed.questions.length} queries, top ${LIMIT}\n\n`,
  );

  const results = {};

  for (const name of Object.keys(variants)) {
    results[name] = { overlap: 0, short: 0, ms: 0, plans: [] };
  }

  let exactMs = 0;

  // One discarded pass. Without it the first variant measured pays for warming
  // the cache and looks three times slower than the ones behind it, which is an
  // artifact of the loop order rather than anything about the index.
  for (const settings of [EXACT, ...Object.values(variants)]) {
    for (const question of seed.questions) await ids(question.embedding, settings);
  }

  for (const question of seed.questions) {
    const truth = await ids(question.embedding, EXACT);
    exactMs += truth.ms;
    const expected = new Set(truth.ids);

    for (const [name, settings] of Object.entries(variants)) {
      const got = await ids(question.embedding, settings);
      results[name].overlap += got.ids.filter((id) => expected.has(id)).length / expected.size;
      results[name].ms += got.ms;
      results[name].plans.push(got.plan);
      if (got.ids.length < LIMIT) results[name].short += 1;
    }
  }

  const n = seed.questions.length;

  process.stdout.write(
    `  ${"".padEnd(26)}${"plan".padStart(11)}${"agree".padStart(8)}` +
      `${"short".padStart(8)}${"ms".padStart(9)}\n` +
      `  ${"exact (ground truth)".padEnd(26)}${"exact".padStart(11)}` +
      `${"1.00".padStart(8)}${"0".padStart(8)}${(exactMs / n).toFixed(1).padStart(9)}\n` +
      Object.entries(results)
        .map(
          ([name, r]) =>
            `  ${name.padEnd(26)}${summarise(r.plans).padStart(11)}` +
            `${(r.overlap / n).toFixed(2).padStart(8)}` +
            `${String(r.short).padStart(8)}${(r.ms / n).toFixed(1).padStart(9)}`,
        )
        .join("\n") +
      "\n\n" +
      "  agree: mean fraction of the exact top-20 that the variant returned\n" +
      "  short: queries that came back with fewer than 20 rows\n" +
      "  ms:    mean wall time for one query, this machine, warm cache\n\n",
  );

  // The same measurement against progressively smaller slices of the tenant.
  // A workspace holding half the table is the easy case; the one that breaks
  // quietly is a small tenant among many, where an HNSW scan that stops after
  // ef_search candidates may find almost nothing that passes the filter.
  const documents = await sql`
    select id from documents where workspace_id = ${seed.workspaceId} order by title
  `;

  process.stdout.write("  smaller tenants, simulated by narrowing to a subset of documents\n\n");
  process.stdout.write(
    `  ${"".padEnd(26)}${"share".padStart(7)}${"plan".padStart(12)}` +
      `${"agree".padStart(8)}${"short".padStart(8)}\n`,
  );

  for (const fraction of [0.25, 0.05, 0.01]) {
    const subset = documents.slice(0, Math.max(1, Math.round(documents.length * fraction)));
    const uuids = subset.map((d) => d.id);

    const [{ rows: slice }] = await sql`
      select count(*)::int as rows from document_chunks
      where document_id = any(${uuids}::uuid[])
    `;

    const share = `${((slice / total) * 100).toFixed(1)}%`;

    for (const [name, settings] of Object.entries({ exact: EXACT, ...variants })) {
      let overlap = 0;
      let short = 0;
      const plans = [];

      for (const question of seed.questions) {
        const truth = await ids(question.embedding, EXACT, uuids);
        const expected = new Set(truth.ids);
        const got = await ids(question.embedding, settings, uuids);

        overlap += expected.size
          ? got.ids.filter((id) => expected.has(id)).length / expected.size
          : 1;
        plans.push(got.plan);
        if (got.ids.length < Math.min(LIMIT, truth.ids.length)) short += 1;
      }

      process.stdout.write(
        `  ${name.padEnd(26)}${share.padStart(7)}${summarise(plans).padStart(12)}` +
          `${(overlap / seed.questions.length).toFixed(2).padStart(8)}` +
          `${String(short).padStart(8)}\n`,
      );
    }

    process.stdout.write("\n");
  }
} finally {
  await sql.end({ timeout: 5 });
}
