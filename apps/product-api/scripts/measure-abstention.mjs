import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/**
 * Does the system refuse questions its documents cannot answer?
 *
 *     # ollama serve, and the AI service on :8000
 *     pnpm --filter @clientatlas/product-api exec node scripts/measure-abstention.mjs
 *
 * This exists because the obvious mechanism does not work.
 *
 * The plan called for a confidence threshold on retrieval: score the best
 * match, refuse below a floor. `scripts/measure-threshold.mjs` measured whether
 * any such floor exists on this corpus, across all three signals available —
 * the fused RRF score, raw cosine similarity, and `ts_rank_cd`. None of them
 * separates the twenty-two answerable questions from the five unanswerable
 * ones. RRF cannot in principle, since it scores rank position and discards
 * magnitude; cosine and ts_rank can in principle and do not in fact, because a
 * question about a topic the handbook covers adjacently scores like one it
 * answers outright.
 *
 * So the refusal has to be semantic: read the passages and decide whether they
 * answer the question. That is what the generator does, instructed by the
 * prompt contract and enforced by the citation gate. This script measures
 * whether it actually works, with the real model, over the whole labelled set.
 *
 * Requires Ollama. It is a measurement, not a gate — CI has no 8B model, and a
 * test that quietly skipped without one would be worse than no test.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

if (existsSync(path.join(REPO, ".env"))) {
  process.loadEnvFile(path.join(REPO, ".env"));
}

const seedPath = path.join(REPO, "evals", "reports", "gitlab-handbook-v1-seed.json");
const url = process.env["TEST_DATABASE_URL"];
const aiUrl = process.env["AI_SERVICE_URL"] ?? "http://127.0.0.1:8000";

if (!existsSync(seedPath) || !url) {
  process.stderr.write("load the corpus and set TEST_DATABASE_URL first\n");
  process.exit(2);
}

const seed = JSON.parse(readFileSync(seedPath, "utf-8"));
const sql = postgres(url, { max: 1, onnotice: () => {} });

const EVIDENCE = 8;
const CANDIDATES = 20;
const RRF_K = 60;

async function retrieve(question) {
  const literal = JSON.stringify(question.embedding);

  const [keyword, vector] = await Promise.all([
    sql`
      select c.id, c.content, d.title, c.page_number, c.ordinal
      from document_chunks c join documents d on d.id = c.document_id
      where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
        and c.content_tsv @@ websearch_to_tsquery('english', ${question.question})
      order by ts_rank_cd(c.content_tsv,
                 websearch_to_tsquery('english', ${question.question})) desc,
               d.title, c.ordinal
      limit ${CANDIDATES}`,
    sql`
      select c.id, c.content, d.title, c.page_number, c.ordinal
      from document_chunks c join documents d on d.id = c.document_id
      where c.workspace_id = ${seed.workspaceId}::uuid and d.status = 'ready'
        and c.embedding is not null
      order by c.embedding <=> ${literal}::vector, d.title, c.ordinal
      limit ${CANDIDATES}`,
  ]);

  const fused = new Map();

  for (const list of [keyword, vector]) {
    list.forEach((row, position) => {
      const found = fused.get(row.id);
      if (found) found.score += 1 / (RRF_K + position + 1);
      else fused.set(row.id, { row, score: 1 / (RRF_K + position + 1) });
    });
  }

  return Array.from(fused.values())
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.row.title.localeCompare(b.row.title) ||
        a.row.ordinal - b.row.ordinal,
    )
    .slice(0, EVIDENCE)
    .map((entry, index) => ({
      ordinal: index + 1,
      chunkId: entry.row.id,
      text: entry.row.content,
      documentTitle: entry.row.title,
      pageNumber: entry.row.page_number,
    }));
}

/** The terminal frame type for one question, through the real model. */
async function ask(question) {
  const evidence = await retrieve(question);

  if (evidence.length === 0) return { outcome: "abstained", reason: "nothing retrieved" };

  const response = await fetch(`${aiUrl}/v1/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: question.question,
      evidence,
      policy: { provider: "local-ollama", requireCitations: true, maxOutputTokens: 512 },
    }),
  });

  if (!response.ok) {
    return { outcome: "error", reason: `ai service returned ${response.status}` };
  }

  const body = await response.text();
  const frames = body
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));

  const terminal = frames.at(-1);
  const answer = frames
    .filter((frame) => frame.type === "token")
    .map((frame) => frame.text)
    .join("");

  return { outcome: terminal?.type ?? "none", reason: terminal?.reason ?? "", answer };
}

try {
  await sql`set hnsw.iterative_scan = strict_order`;

  const rows = [];

  for (const question of seed.questions) {
    const started = Date.now();
    const result = await ask(question);

    rows.push({
      id: question.id,
      answerable: question.answerable,
      category: question.category,
      outcome: result.outcome,
      seconds: (Date.now() - started) / 1000,
    });

    process.stdout.write(
      `  ${question.id}  ${question.answerable ? "answerable  " : "unanswerable"}  ` +
        `${result.outcome.padEnd(10)}${rows.at(-1).seconds.toFixed(1)}s\n`,
    );
  }

  const answerable = rows.filter((row) => row.answerable);
  const unanswerable = rows.filter((row) => !row.answerable);

  const refused = unanswerable.filter((row) => row.outcome === "abstained").length;
  const answered = answerable.filter((row) => row.outcome === "done").length;

  process.stdout.write(
    `\n  correctly refused   ${refused}/${unanswerable.length} unanswerable\n` +
      `  correctly answered  ${answered}/${answerable.length} answerable\n` +
      `  median latency      ${rows
        .map((row) => row.seconds)
        .sort((a, b) => a - b)
        [Math.floor(rows.length / 2)].toFixed(1)}s\n\n`,
  );
} finally {
  await sql.end({ timeout: 5 });
}
