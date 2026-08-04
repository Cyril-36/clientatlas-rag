import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRuntimeSql } from "@/lib/database/client";
import { withTenantContext } from "@/lib/database/tenant";
import { hybridSearch } from "@/lib/retrieval/search";

/**
 * Retrieval measured through the real query path.
 *
 * The earlier version of this file skipped silently when no corpus was seeded,
 * and its assertions were satisfiable by an empty table: `hybrid >= vector`
 * holds at `0 >= 0`, and a cross-tenant expectation of `[]` holds when there is
 * nothing to leak. It lived beside five suites that truncate the corpus, so
 * both outcomes were reachable in an ordinary run.
 *
 * Now it fails loudly instead. Absent corpus, empty corpus, or a query that
 * returns nothing for its own owner are all errors that say what to do, and the
 * cross-tenant check is only meaningful *because* the owner's query is asserted
 * non-empty first.
 *
 *     cd services/ai && uv run python ../../evals/prepare_corpus.py gitlab-handbook-v1
 *     pnpm --filter @clientatlas/product-api exec node scripts/load-corpus.mjs gitlab-handbook-v1
 *     pnpm --filter @clientatlas/product-api run measure:retrieval
 */

const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../evals/reports/gitlab-handbook-v1-seed.json",
);

interface SeedQuestion {
  id: string;
  question: string;
  category: string;
  expected: { document: string; mustContain: string }[];
  embedding: number[];
}

interface Seed {
  userId: string;
  workspaceId: string;
  chunks: number;
  questions: SeedQuestion[];
}

const seed: Seed | null = existsSync(SEED)
  ? (JSON.parse(readFileSync(SEED, "utf-8")) as Seed)
  : null;

afterAll(async () => {
  await getRuntimeSql().end({ timeout: 5 });
});

describe("hybrid retrieval over a seeded corpus", () => {
  const claims = { sub: seed?.userId ?? "", role: "authenticated" as const, email: null };

  beforeAll(() => {
    if (!seed) {
      throw new Error(
        `No seeded corpus at ${SEED}.\n` +
          "  cd services/ai && uv run python ../../evals/prepare_corpus.py gitlab-handbook-v1\n" +
          "  pnpm --filter @clientatlas/product-api exec node scripts/load-corpus.mjs gitlab-handbook-v1",
      );
    }
  });

  it("has a corpus that is actually present in the database", async () => {
    // The guard everything else depends on. A truncated corpus previously made
    // every assertion below pass while measuring nothing.
    const rows = await withTenantContext(claims, (tx) =>
      tx.execute<{ count: number }>(sql`
        select count(*)::int as count from document_chunks
        where workspace_id = ${seed!.workspaceId}::uuid
      `),
    );

    const count = Array.from(rows as Iterable<{ count: number }>)[0]?.count ?? 0;

    expect(
      count,
      `workspace ${seed!.workspaceId} has no chunks — the seed file is stale. Re-load the corpus.`,
    ).toBeGreaterThan(0);
    expect(count).toBe(seed!.chunks);
  });

  it("reports which plan PostgreSQL chose, because the numbers depend on it", async () => {
    // Retrieval quality is not a property of the code alone. With a tenant
    // predicate the planner may use the workspace btree and sort exactly, or
    // the HNSW index and approximate. Measured on this corpus the difference is
    // vector recall@10 0.82 against 0.77 — and which one you get depends on row
    // count and statistics, so it can flip under you between runs.
    //
    // ANALYZE first so the plan is settled rather than whatever autovacuum had
    // reached, then record it beside the numbers.
    await getRuntimeSql()`analyze document_chunks`;

    const rows = await withTenantContext(claims, (tx) =>
      tx.execute<{ "QUERY PLAN": string }>(sql`
        explain select c.id
        from document_chunks c join documents d on d.id = c.document_id
        where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
          and c.embedding is not null
        order by c.embedding <=> ${JSON.stringify(seed!.questions[0]!.embedding)}::vector,
                 d.title, c.ordinal
        limit 20
      `),
    );

    const plan = Array.from(rows as Iterable<Record<string, string>>)
      .map((r) => Object.values(r)[0])
      .join("\n");

    const usesHnsw = plan.includes("document_chunks_embedding_idx");
    console.log(`\n  vector plan: ${usesHnsw ? "HNSW (approximate)" : "exact scan"}`);

    expect(plan.length).toBeGreaterThan(0);
  });

  it("measures recall and evidence completeness", async () => {
    const ks = [1, 5, 10] as const;
    const modes = ["hybrid", "vector", "keyword"] as const;

    const totals: Record<string, Record<number, { any: number; all: number }>> = {};
    for (const mode of modes) {
      totals[mode] = { 1: { any: 0, all: 0 }, 5: { any: 0, all: 0 }, 10: { any: 0, all: 0 } };
    }

    let hybridRowsSeen = 0;

    await withTenantContext(claims, async (tx) => {
      for (const question of seed!.questions) {
        const hybrid = await hybridSearch(tx, {
          workspaceId: seed!.workspaceId,
          query: question.question,
          queryEmbedding: question.embedding,
          candidates: 20,
          limit: 10,
        });
        hybridRowsSeen += hybrid.length;

        const rowsOf = async (query: ReturnType<typeof sql>) =>
          Array.from(
            (await tx.execute<{ document_title: string; content: string }>(query)) as Iterable<{
              document_title: string;
              content: string;
            }>,
          ).map((r) => ({ documentTitle: r.document_title, content: r.content }));

        const byMode = {
          hybrid: hybrid.map((r) => ({ documentTitle: r.documentTitle, content: r.content })),
          vector: await rowsOf(sql`
            select d.title as document_title, c.content as content
            from document_chunks c join documents d on d.id = c.document_id
            where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
            order by c.embedding <=> ${JSON.stringify(question.embedding)}::vector,
                     d.title, c.ordinal
            limit 10`),
          keyword: await rowsOf(sql`
            select d.title as document_title, c.content as content
            from document_chunks c join documents d on d.id = c.document_id
            where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
              and c.content_tsv @@ websearch_to_tsquery('english', ${question.question})
            order by ts_rank_cd(c.content_tsv,
                       websearch_to_tsquery('english', ${question.question})) desc,
                     d.title, c.ordinal
            limit 10`),
        };

        for (const mode of modes) {
          for (const k of ks) {
            const rows = byMode[mode].slice(0, k);
            const hits = question.expected.map((e) =>
              rows.some((r) => r.documentTitle === e.document && r.content.includes(e.mustContain)),
            );
            if (hits.some(Boolean)) totals[mode]![k]!.any += 1;
            if (hits.every(Boolean)) totals[mode]![k]!.all += 1;
          }
        }
      }
    });

    const n = seed!.questions.length;
    const pct = (x: number) => (x / n).toFixed(2);

    console.log(
      `\n  ${seed!.chunks} chunks, ${n} scored questions, through the real index\n\n` +
        `  ${"".padEnd(10)}${"recall@1".padStart(10)}${"recall@5".padStart(10)}` +
        `${"recall@10".padStart(11)}${"compl@5".padStart(10)}${"compl@10".padStart(10)}\n` +
        modes
          .map(
            (m) =>
              `  ${m.padEnd(10)}${pct(totals[m]![1]!.any).padStart(10)}` +
              `${pct(totals[m]![5]!.any).padStart(10)}${pct(totals[m]![10]!.any).padStart(11)}` +
              `${pct(totals[m]![5]!.all).padStart(10)}${pct(totals[m]![10]!.all).padStart(10)}`,
          )
          .join("\n"),
    );

    // Non-degeneracy first: without this, everything below is satisfiable by
    // retrieving nothing at all.
    expect(hybridRowsSeen, "hybrid returned no rows for any question").toBeGreaterThan(0);
    expect(totals["hybrid"]![10]!.any, "hybrid found nothing at k=10").toBeGreaterThan(0);

    // Then the real gate: fusion must not lose to its own vector half.
    expect(totals["hybrid"]![10]!.any).toBeGreaterThanOrEqual(totals["vector"]![10]!.any);
  });

  it("scopes results to the caller's tenant", async () => {
    // Asserted as a pair. The owner must get rows and the stranger must not —
    // checking only the second passes trivially against an empty table, which
    // is exactly how this test used to pass.
    const owner = await withTenantContext(claims, (tx) =>
      hybridSearch(tx, {
        workspaceId: seed!.workspaceId,
        query: seed!.questions[0]!.question,
        queryEmbedding: seed!.questions[0]!.embedding,
      }),
    );

    const stranger = await withTenantContext(
      { sub: "00000000-0000-4000-8000-000000000001", role: "authenticated", email: null },
      (tx) =>
        hybridSearch(tx, {
          workspaceId: seed!.workspaceId,
          query: seed!.questions[0]!.question,
          queryEmbedding: seed!.questions[0]!.embedding,
        }),
    );

    expect(owner.length).toBeGreaterThan(0);
    expect(stranger).toEqual([]);
  });
});
