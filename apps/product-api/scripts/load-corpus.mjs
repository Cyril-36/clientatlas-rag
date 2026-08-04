import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/**
 * Load a prepared evaluation corpus into a real workspace.
 *
 *     cd services/ai && uv run python ../../evals/prepare_corpus.py gitlab-handbook-v1
 *     pnpm --filter @clientatlas/product-api exec node scripts/load-corpus.mjs gitlab-handbook-v1
 *
 * Chunking and embedding happen in Python because the model lives there. Every
 * tenant-scoped write happens here, because that is the rule the whole design
 * rests on: the AI service holds no database access, and a test fails the build
 * if a driver is ever added to it. An earlier version of this seeder ignored
 * that and wrote rows from Python.
 *
 * Uses the BYPASSRLS test credential. Seeding is not the thing under test, and
 * pushing 5,000 chunks through the upload API would measure the upload API.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

if (existsSync(path.join(REPO, ".env"))) {
  process.loadEnvFile(path.join(REPO, ".env"));
}

const dataset = process.argv[2];

if (!dataset) {
  process.stderr.write("usage: node scripts/load-corpus.mjs <dataset>\n");
  process.exit(2);
}

const preparedPath = path.join(REPO, "evals", "reports", `${dataset}-prepared.json`);

if (!existsSync(preparedPath)) {
  process.stderr.write(
    `no prepared corpus at ${preparedPath}\n` +
      `run: cd services/ai && uv run python ../../evals/prepare_corpus.py ${dataset}\n`,
  );
  process.exit(2);
}

const url = process.env["TEST_DATABASE_URL"];

if (!url) {
  process.stderr.write("TEST_DATABASE_URL is not set\n");
  process.exit(2);
}

const prepared = JSON.parse(readFileSync(preparedPath, "utf-8"));
const sql = postgres(url, { max: 4, onnotice: () => {} });

const userId = randomUUID();
const organizationId = randomUUID();
const workspaceId = randomUUID();

try {
  await sql.begin(async (tx) => {
    // A fresh tenant per load, so repeated runs cannot accumulate into each
    // other and quietly change the corpus being measured.
    await tx`insert into profiles (id, email, display_name)
             values (${userId}, ${`eval-${userId.slice(0, 8)}@example.test`}, 'eval')`;
    await tx`insert into organizations (id, name, slug)
             values (${organizationId}, ${`eval ${dataset}`}, ${`eval-${organizationId.slice(0, 8)}`})`;
    await tx`insert into organization_members (organization_id, user_id, role)
             values (${organizationId}, ${userId}, 'owner')`;
    await tx`insert into workspaces (id, organization_id, name, slug)
             values (${workspaceId}, ${organizationId}, ${dataset}, 'eval')`;

    for (const document of prepared.documents) {
      const documentId = randomUUID();
      const versionId = randomUUID();

      await tx`insert into documents
                 (id, organization_id, workspace_id, title, original_filename, media_type, status)
               values (${documentId}, ${organizationId}, ${workspaceId}, ${document.slug},
                       ${`${document.slug}.pdf`}, ${document.mediaType}, 'ready')`;

      await tx`insert into document_versions
                 (id, organization_id, document_id, version_number, storage_path,
                  byte_size, checksum_sha256)
               values (${versionId}, ${organizationId}, ${documentId}, 1,
                       ${`organizations/${organizationId}/workspaces/${workspaceId}/documents/${documentId}/${versionId}.pdf`},
                       1, ${"0".repeat(64)})`;

      for (const chunk of document.chunks) {
        await tx`insert into document_chunks
                   (organization_id, workspace_id, document_id, document_version_id,
                    ordinal, content, page_number, heading_path, token_count, embedding)
                 values (${organizationId}, ${workspaceId}, ${documentId}, ${versionId},
                         ${chunk.ordinal}, ${chunk.text}, ${chunk.pageNumber},
                         ${chunk.headingPath}, ${chunk.tokenCount},
                         ${JSON.stringify(chunk.embedding)}::vector)`;
      }
    }
  });

  const [{ count }] = await sql`
    select count(*)::int as count from document_chunks where workspace_id = ${workspaceId}
  `;

  writeFileSync(
    path.join(REPO, "evals", "reports", `${dataset}-seed.json`),
    JSON.stringify({
      dataset,
      userId,
      organizationId,
      workspaceId,
      chunks: count,
      questions: prepared.questions,
    }),
  );

  process.stdout.write(`loaded ${count} chunks into workspace ${workspaceId}\n`);
} finally {
  await sql.end({ timeout: 5 });
}
