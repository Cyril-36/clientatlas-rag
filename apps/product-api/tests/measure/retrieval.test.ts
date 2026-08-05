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

  it("runs vector search with iterative scan enabled", async () => {
    // `set local` lasts for the transaction, so asking after the search is
    // asking whether the search actually set it. Without this the setting is a
    // comment: the query works either way, it just silently returns short
    // pages for small tenants, which is precisely the failure that has no
    // symptom. scripts/measure-ann.mjs is what measures the difference.
    const setting = await withTenantContext(claims, async (tx) => {
      await hybridSearch(tx, {
        workspaceId: seed!.workspaceId,
        query: seed!.questions[0]!.question,
        queryEmbedding: seed!.questions[0]!.embedding,
      });

      const rows = await tx.execute<{ value: string }>(
        sql`select current_setting('hnsw.iterative_scan') as value`,
      );

      return Array.from(rows as Iterable<{ value: string }>)[0]?.value;
    });

    expect(setting).toBe("strict_order");

    // And that it does not outlive the transaction that set it.
    const [after] = Array.from(
      (await getRuntimeSql()`select current_setting('hnsw.iterative_scan') as value`) as Iterable<{
        value: string;
      }>,
    );

    expect(after?.value).toBe("off");
  });

  it("measures recall and evidence completeness", async () => {
    const ks = [1, 5, 10] as const;
    const modes = ["hybrid", "vector", "keyword", "vector (exact)"] as const;

    const totals: Record<string, Record<number, { any: number; all: number }>> = {};
    for (const mode of modes) {
      totals[mode] = { 1: { any: 0, all: 0 }, 5: { any: 0, all: 0 }, 10: { any: 0, all: 0 } };
    }

    let hybridRowsSeen = 0;
    let plan = "";

    type Rows = { documentTitle: string; content: string }[];

    const score = (question: SeedQuestion, byMode: Partial<Record<string, Rows>>) => {
      for (const [mode, rows] of Object.entries(byMode)) {
        for (const k of ks) {
          const top = rows!.slice(0, k);
          const hits = question.expected.map((e) =>
            top.some((r) => r.documentTitle === e.document && r.content.includes(e.mustContain)),
          );
          if (hits.some(Boolean)) totals[mode]![k]!.any += 1;
          if (hits.every(Boolean)) totals[mode]![k]!.all += 1;
        }
      }
    };

    // ANALYZE first, so the plan is settled rather than whatever autovacuum had
    // reached when the run started.
    await getRuntimeSql()`analyze document_chunks`;

    await withTenantContext(claims, async (tx) => {
      // The vector-only arm below is a comparison against what hybrid does, so
      // it has to run under the same settings hybrid runs under. `hybridSearch`
      // sets this itself, and `set local` lasts for the whole transaction, so
      // leaving it implicit would mean the first question was measured under
      // one configuration and the rest under another.
      await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);

      // Which plan, taken here rather than in a test of its own.
      //
      // An earlier version asked in a separate transaction, which does not
      // answer the question: the planner decides per execution, and two
      // consecutive runs over an unchanged 5,393-row single-tenant table have
      // been observed to choose differently. A plan sampled somewhere else is a
      // plausible guess about this run, not a record of it.
      const explained = await tx.execute<Record<string, string>>(sql`
        explain select c.id
        from document_chunks c join documents d on d.id = c.document_id
        where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
          and c.embedding is not null
        order by c.embedding <=> ${JSON.stringify(seed!.questions[0]!.embedding)}::vector,
                 d.title, c.ordinal
        limit 20
      `);

      plan = Array.from(explained as Iterable<Record<string, string>>)
        .map((r) => Object.values(r)[0])
        .join("\n")
        .includes("document_chunks_embedding_idx")
        ? "HNSW (approximate)"
        : "exact scan";

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
          // Deliberately the same shape as `vectorCandidates`, down to the
          // `embedding is not null` predicate. Without it this is a different
          // query, the planner may cost it differently, and "hybrid beats
          // vector" would be comparing two things that were never run the same
          // way.
          vector: await rowsOf(sql`
            select d.title as document_title, c.content as content
            from document_chunks c join documents d on d.id = c.document_id
            where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
              and c.embedding is not null
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

        score(question, byMode);
      }
    });

    // The same vector query with the index taken away, so the cost of
    // approximation is measured rather than inferred.
    //
    // This exists because the alternative was waiting for the planner to change
    // its mind and hoping to notice. Two runs of this suite against an
    // unchanged single-tenant table have chosen differently, so pairing a set
    // of numbers with a row count — as an earlier version of the report did —
    // records a coincidence. Forcing the plan makes the comparison repeatable
    // on demand, in one run, on one state of the data.
    await withTenantContext(claims, async (tx) => {
      await tx.execute(sql`set local enable_indexscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);

      for (const question of seed!.questions) {
        const rows = Array.from(
          (await tx.execute<{ document_title: string; content: string }>(sql`
            select d.title as document_title, c.content as content
            from document_chunks c join documents d on d.id = c.document_id
            where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
              and c.embedding is not null
            order by c.embedding <=> ${JSON.stringify(question.embedding)}::vector,
                     d.title, c.ordinal
            limit 10`)) as Iterable<{ document_title: string; content: string }>,
        ).map((r) => ({ documentTitle: r.document_title, content: r.content }));

        score(question, { "vector (exact)": rows });
      }
    });

    const n = seed!.questions.length;
    const pct = (x: number) => (x / n).toFixed(2);

    console.log(
      `\n  ${seed!.chunks} chunks, ${n} scored questions, through the real index\n` +
        `  vector plan for this run: ${plan}\n\n` +
        `  ${"".padEnd(16)}${"recall@1".padStart(10)}${"recall@5".padStart(10)}` +
        `${"recall@10".padStart(11)}${"compl@5".padStart(10)}${"compl@10".padStart(10)}\n` +
        modes
          .map(
            (m) =>
              `  ${m.padEnd(16)}${pct(totals[m]![1]!.any).padStart(10)}` +
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

    // And it must not lose to the vector half unhandicapped. Hybrid's own
    // vector arm runs approximately, so beating it is a lower bar than beating
    // an exact scan of the same rows — that is the number a reader would
    // reasonably assume "hybrid beats vector" meant, so it is the one asserted.
    expect(
      totals["hybrid"]![10]!.any,
      "hybrid lost to an exact vector-only scan",
    ).toBeGreaterThanOrEqual(totals["vector (exact)"]![10]!.any);
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
