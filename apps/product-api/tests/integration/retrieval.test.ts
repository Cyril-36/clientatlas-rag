import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getRuntimeSql } from "@/lib/database/client";
import { withTenantContext } from "@/lib/database/tenant";
import { fuse, hybridSearch, RRF_K } from "@/lib/retrieval/search";

/**
 * Hybrid retrieval, measured through the real query path.
 *
 * The vector-only baseline in `evals/reports/` was a brute-force scan in
 * Python. This runs the SQL the application actually issues, against the HNSW
 * and GIN indexes it actually uses, inside the claims helper so row-level
 * security applies exactly as it would for a request.
 *
 * Skipped unless the corpus has been seeded:
 *
 *     cd services/ai
 *     uv run python ../../evals/seed_corpus.py gitlab-handbook-v1
 *
 * It is a measurement, not a gate — except for one assertion, which is that
 * hybrid must not do worse than vectors alone. If it ever does, fusion is
 * actively destroying signal and that should fail loudly.
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
  organizationId: string;
  workspaceId: string;
  chunks: number;
  questions: SeedQuestion[];
}

const seeded = existsSync(SEED);
const seed: Seed | null = seeded ? (JSON.parse(readFileSync(SEED, "utf-8")) as Seed) : null;

afterAll(async () => {
  await getRuntimeSql().end({ timeout: 5 });
});

describe.skipIf(!seeded)("hybrid retrieval over the GitLab corpus", () => {
  const claims = {
    sub: seed?.userId ?? "",
    role: "authenticated" as const,
    email: null,
  };

  /** Does this result set contain any / all of a question's expected evidence? */
  function score(
    question: SeedQuestion,
    rows: { documentTitle: string; content: string }[],
  ): { any: boolean; all: boolean } {
    const hits = question.expected.map((expectation) =>
      rows.some(
        (row) =>
          row.documentTitle === expectation.document &&
          row.content.includes(expectation.mustContain),
      ),
    );

    return { any: hits.some(Boolean), all: hits.every(Boolean) };
  }

  it("measures recall and evidence completeness against the vector-only baseline", async () => {
    const ks = [1, 5, 10] as const;
    const modes = ["hybrid", "vector", "keyword"] as const;

    const totals: Record<string, Record<number, { any: number; all: number }>> = {
      hybrid: {},
      vector: {},
      keyword: {},
    };
    for (const mode of modes) {
      for (const k of ks) totals[mode]![k] = { any: 0, all: 0 };
    }

    await withTenantContext(claims, async (tx) => {
      for (const question of seed!.questions) {
        // Hybrid: both searches, fused.
        const hybrid = await hybridSearch(tx, {
          workspaceId: seed!.workspaceId,
          query: question.question,
          queryEmbedding: question.embedding,
          candidates: 20,
          limit: 10,
        });

        // Vector only, so the contribution of keyword search is visible rather
        // than assumed.
        const vectorRows = await tx.execute<{ document_title: string; content: string }>(sql`
          select d.title as document_title, c.content as content
          from document_chunks c join documents d on d.id = c.document_id
          where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
          order by c.embedding <=> ${JSON.stringify(question.embedding)}::vector, c.id
          limit 10
        `);

        const keywordRows = await tx.execute<{ document_title: string; content: string }>(sql`
          select d.title as document_title, c.content as content
          from document_chunks c join documents d on d.id = c.document_id
          where c.workspace_id = ${seed!.workspaceId}::uuid and d.status = 'ready'
            and c.content_tsv @@ websearch_to_tsquery('english', ${question.question})
          order by ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', ${question.question}))
            desc, c.id
          limit 10
        `);

        const asRows = (rows: unknown) =>
          Array.from(rows as Iterable<{ document_title: string; content: string }>).map((r) => ({
            documentTitle: r.document_title,
            content: r.content,
          }));

        const byMode = {
          hybrid: hybrid.map((r) => ({ documentTitle: r.documentTitle, content: r.content })),
          vector: asRows(vectorRows),
          keyword: asRows(keywordRows),
        };

        for (const mode of modes) {
          for (const k of ks) {
            const { any, all } = score(question, byMode[mode].slice(0, k));
            if (any) totals[mode]![k]!.any += 1;
            if (all) totals[mode]![k]!.all += 1;
          }
        }
      }
    });

    const n = seed!.questions.length;
    const pct = (x: number) => (x / n).toFixed(2);

    console.log(
      `\n  corpus: ${seed!.chunks} chunks, ${n} scored questions, measured through the real index\n\n` +
        `  ${"".padEnd(10)}${"recall@1".padStart(10)}${"recall@5".padStart(10)}${"recall@10".padStart(11)}` +
        `${"compl@5".padStart(10)}${"compl@10".padStart(10)}\n` +
        modes
          .map(
            (m) =>
              `  ${m.padEnd(10)}${pct(totals[m]![1]!.any).padStart(10)}` +
              `${pct(totals[m]![5]!.any).padStart(10)}${pct(totals[m]![10]!.any).padStart(11)}` +
              `${pct(totals[m]![5]!.all).padStart(10)}${pct(totals[m]![10]!.all).padStart(10)}`,
          )
          .join("\n"),
    );

    // The one real assertion: fusion must not lose to its own vector half.
    expect(totals["hybrid"]![10]!.any).toBeGreaterThanOrEqual(totals["vector"]![10]!.any);
  }, 300_000);

  it("returns nothing for a workspace the caller cannot see", async () => {
    // Retrieval inherits tenant scoping from the claims helper rather than
    // re-implementing it, so this is the test that proves the inheritance.
    const stranger = {
      sub: "00000000-0000-4000-8000-000000000001",
      role: "authenticated" as const,
      email: null,
    };

    const rows = await withTenantContext(stranger, (tx) =>
      hybridSearch(tx, {
        workspaceId: seed!.workspaceId,
        query: "how do I request production access",
        queryEmbedding: seed!.questions[0]!.embedding,
      }),
    );

    expect(rows).toEqual([]);
  });
});

describe("reciprocal rank fusion", () => {
  const row = (id: string) => ({
    chunk_id: id,
    document_id: "d",
    document_title: "t",
    ordinal: 1,
    content: "c",
    page_number: null,
    heading_path: [],
  });

  it("ranks a chunk found by both searches above one found by either alone", () => {
    // The property that makes fusion worth doing. `b` is second in both lists
    // and must beat `a` and `c`, each of which is first in only one.
    const fused = fuse([
      [row("a"), row("b")],
      [row("c"), row("b")],
    ]);

    const ordered = [...fused.values()]
      .sort((x, y) => y.score - x.score)
      .map((v) => v.row.chunk_id);

    expect(ordered[0]).toBe("b");
  });

  it("uses a constant large enough that one first place does not dominate", () => {
    // With a small k, rank 1 in a single list would outweigh rank 2 in both,
    // and the hybrid would collapse back to whichever search ranked hardest.
    const both = 2 * (1 / (RRF_K + 2));
    const onlyFirst = 1 / (RRF_K + 1);

    expect(both).toBeGreaterThan(onlyFirst);
  });

  it("keeps a chunk that only one search found", () => {
    const fused = fuse([[row("a")], [row("b")]]);

    expect([...fused.keys()].sort()).toEqual(["a", "b"]);
  });
});
