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
    // A fresh tenant per load. That keeps the *contents* of the measured
    // corpus identical across runs — a second load cannot add rows to the
    // workspace the first one created.
    //
    // It does not make repeated loads independent, and the earlier comment
    // here claimed it did. Every load leaves its tenant behind, so the table
    // keeps growing, and PostgreSQL chooses a plan from the size of the whole
    // table rather than one tenant's slice of it. Two loads of this corpus were
    // enough to move the vector query from an exact scan to the HNSW index and
    // change measured recall. The count printed at the end says how much of the
    // table is not yours, because that is the part that moves the numbers.
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

  const [{ total, tenants }] = await sql`
    select count(*)::int as total, count(distinct workspace_id)::int as tenants
    from document_chunks
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

  process.stdout.write(
    `loaded ${count} chunks into workspace ${workspaceId}\n` +
      `document_chunks now holds ${total} rows across ${tenants} workspace(s)\n`,
  );

  if (tenants > 1) {
    process.stdout.write(
      `\n${total - count} of those rows belong to earlier loads. The planner sizes\n` +
        "its choice on the whole table, so a measurement taken now is not\n" +
        "comparable to one taken against a single tenant. Either keep the\n" +
        "comparison within one state of this table, or clear the earlier\n" +
        "tenants first:\n\n" +
        "  delete from organizations where slug like 'eval-%';\n",
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}
