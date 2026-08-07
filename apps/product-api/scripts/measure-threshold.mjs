import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/**
 * Where should the abstention threshold go?
 *
 *     pnpm --filter @clientatlas/product-api exec node scripts/measure-threshold.mjs
 *
 * Retrieval always returns its top k, whether or not anything in the corpus
 * answers the question. Asked something the documents do not cover, it returns
 * the eight least-unrelated passages it has, and the generator is then handed a
 * plausible-looking evidence pack for a question with no answer. Abstention
 * currently fires only when retrieval returns *nothing*, which on a corpus of
 * any size effectively never happens.
 *
 * A floor on the fused score is the remedy, and the number cannot be guessed.
 * The dataset has five questions written to be unanswerable from this corpus
 * and twenty-two written to be answerable, so the question this script asks is
 * whether the top fused score separates them, and where.
 *
 * What it prints is the full trade-off, not a recommendation: for every
 * candidate threshold, how many unanswerable questions are correctly refused
 * and how many answerable ones are wrongly refused. Choosing between those is a
 * product decision, and it should be made while looking at both columns.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

if (existsSync(path.join(REPO, ".env"))) {
  process.loadEnvFile(path.join(REPO, ".env"));
}

const seedPath = path.join(REPO, "evals", "reports", "gitlab-handbook-v1-seed.json");

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

const CANDIDATES = 20;
const RRF_K = 60;

/**
 * Three candidate signals for one question.
 *
 * `rrf` is the fused top score, by the same rules `search.ts` uses. It is
 * measured first and it is the one the plan assumed would work.
 *
 * `cosine` and `tsRank` are the raw scores underneath the fusion, kept because
 * RRF discards exactly the thing a threshold needs. Fusion scores by rank
 * position alone — a chunk ranked first by both searches scores 2/61 whether it
 * is a perfect match or the least bad of five thousand irrelevant ones — so the
 * fused score cannot distinguish a good answer from no answer, by construction
 * rather than by accident.
 */
async function signals(question) {
  const literal = JSON.stringify(question.embedding);

  const [best] = await sql`
    select max(1 - (c.embedding <=> ${literal}::vector)) as cosine
    from document_chunks c join documents d on d.id = c.document_id
    where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
      and c.embedding is not null`;

  const [rank] = await sql`
    select coalesce(max(ts_rank_cd(c.content_tsv,
             websearch_to_tsquery('english', ${question.question}))), 0) as ts_rank
    from document_chunks c join documents d on d.id = c.document_id
    where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
      and c.content_tsv @@ websearch_to_tsquery('english', ${question.question})`;

  const [keyword, vector] = await Promise.all([
    sql`
      select c.id
      from document_chunks c join documents d on d.id = c.document_id
      where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
        and c.content_tsv @@ websearch_to_tsquery('english', ${question.question})
      order by ts_rank_cd(c.content_tsv,
                 websearch_to_tsquery('english', ${question.question})) desc,
               d.title, c.ordinal
      limit ${CANDIDATES}`,
    sql`
      select c.id
      from document_chunks c join documents d on d.id = c.document_id
      where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
        and c.embedding is not null
      order by c.embedding <=> ${literal}::vector, d.title, c.ordinal
      limit ${CANDIDATES}`,
  ]);

  const fused = new Map();

  for (const list of [keyword, vector]) {
    list.forEach((row, position) => {
      fused.set(row.id, (fused.get(row.id) ?? 0) + 1 / (RRF_K + position + 1));
    });
  }

  return {
    rrf: Math.max(0, ...fused.values()),
    cosine: Number(best.cosine),
    tsRank: Number(rank.ts_rank),
  };
}

try {
  await sql`set hnsw.iterative_scan = strict_order`;
  await sql`analyze document_chunks`;

  const scored = [];

  for (const question of seed.questions) {
    scored.push({
      id: question.id,
      answerable: question.answerable,
      category: question.category,
      ...(await signals(question)),
    });
  }

  const answerable = scored.filter((row) => row.answerable);
  const unanswerable = scored.filter((row) => !row.answerable);

  for (const signal of ["rrf", "cosine", "tsRank"]) {
    const summarise = (rows, label) => {
      const values = rows.map((row) => row[signal]).sort((a, b) => a - b);
      return (
        `  ${label.padEnd(14)}n=${String(rows.length).padStart(2)}  ` +
        `min ${values[0].toFixed(5)}  ` +
        `median ${values[Math.floor(values.length / 2)].toFixed(5)}  ` +
        `max ${values.at(-1).toFixed(5)}`
      );
    };

    process.stdout.write(
      `\n=== ${signal} ===\n\n` +
        summarise(answerable, "answerable") +
        "\n" +
        summarise(unanswerable, "unanswerable") +
        "\n\n",
    );

    // Every threshold worth considering is a score that actually occurred:
    // anything between two observed scores behaves identically to the lower one.
    const thresholds = [...new Set(scored.map((row) => row[signal]))].sort((a, b) => a - b);

    process.stdout.write(
      `  ${"threshold".padStart(10)}${"refused/5".padStart(12)}${"lost/22".padStart(10)}  lost\n`,
    );

    for (const threshold of thresholds) {
      const refused = unanswerable.filter((row) => row[signal] < threshold).length;
      const lost = answerable.filter((row) => row[signal] < threshold);

      process.stdout.write(
        `  ${threshold.toFixed(5).padStart(10)}${String(refused).padStart(12)}` +
          `${String(lost.length).padStart(10)}  ${lost.map((row) => row.id).join(" ")}\n`,
      );
    }
  }

  process.stdout.write(
    "\n  refused: unanswerable questions correctly abstained on\n" +
      "  lost:    answerable questions wrongly abstained on\n\n",
  );
} finally {
  await sql.end({ timeout: 5 });
}
