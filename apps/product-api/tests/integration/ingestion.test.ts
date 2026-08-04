import { randomUUID } from "node:crypto";
import process from "node:process";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@clientatlas/contracts";
import * as schema from "@clientatlas/database/schema";
import { claimNextJob } from "@clientatlas/database/queue";
import {
  processJob,
  type AiClient,
  type EmbedResult,
  type ParseResult,
  type StorageClient,
} from "@clientatlas/worker/process-job";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getRuntimeSql } from "@/lib/database/client";
import { withTenantContext } from "@/lib/database/tenant";

import { createTenant, truncateTenantTables, type Tenant } from "./helpers/fixtures";

/**
 * The worker, against a real database with fake models.
 *
 * The AI service and object storage are injected so the failure paths are
 * reachable — a download that fails, a parser that throws, an embedding service
 * returning the wrong model. Those are the branches that decide whether a bad
 * document retries, gives up, or quietly corrupts retrieval, and none of them
 * is reachable by uploading a good file.
 */

let alpha: Tenant;
let worker: postgres.Sql;

const PDF = new Uint8Array(Buffer.from("%PDF-1.7\nhandbook\n%%EOF\n", "latin1"));

function goodParse(chunkCount = 3): ParseResult {
  return {
    pageCount: 2,
    checksumSha256: "b".repeat(64),
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      ordinal: index + 1,
      text: `Chunk ${index + 1} about access requests.`,
      pageNumber: 1,
      headingPath: ["Security"],
      tokenCount: 12,
    })),
  };
}

function realisticEmbedding(count: number): EmbedResult {
  return {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    vectors: Array.from({ length: count }, () => new Array(EMBEDDING_DIMENSIONS).fill(0.05)),
  };
}

function fakeAi(overrides: Partial<AiClient> = {}): AiClient {
  return {
    parse: async () => goodParse(),
    embed: async (texts: string[]) => realisticEmbedding(texts.length),
    ...overrides,
  };
}

const fakeStorage: StorageClient = { download: async () => PDF };

async function seedDocumentWithJob(
  tenant: Tenant,
): Promise<{ documentId: string; versionId: string }> {
  const documentId = randomUUID();
  const versionId = randomUUID();

  await withTenantContext(tenant.claims, async (tx) => {
    await tx.insert(schema.documents).values({
      id: documentId,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      title: "handbook",
      originalFilename: "handbook.pdf",
      mediaType: "application/pdf",
    });

    await tx.insert(schema.documentVersions).values({
      id: versionId,
      organizationId: tenant.organizationId,
      documentId,
      versionNumber: 1,
      storagePath: `organizations/${tenant.organizationId}/workspaces/${tenant.workspaceId}/documents/${documentId}/${versionId}.pdf`,
      byteSize: PDF.length,
      checksumSha256: "a".repeat(64),
    });

    await tx.insert(schema.ingestionJobs).values({
      organizationId: tenant.organizationId,
      documentId,
      documentVersionId: versionId,
    });
  });

  return { documentId, versionId };
}

async function documentStatus(documentId: string): Promise<string> {
  const [row] = await worker<{ status: string }[]>`
    select status from documents where id = ${documentId}
  `;
  return row?.status ?? "missing";
}

beforeAll(async () => {
  await truncateTenantTables();
  alpha = await createTenant("alpha");

  const url = process.env["WORKER_DATABASE_URL"];
  if (!url) {
    throw new Error("WORKER_DATABASE_URL is not set.");
  }

  worker = postgres(url, { max: 4, onnotice: () => {} });
});

beforeEach(async () => {
  await worker`delete from ingestion_jobs`;
  await worker`delete from document_chunks`;
});

afterAll(async () => {
  await worker?.end({ timeout: 5 });
  await truncateTenantTables();
  await getRuntimeSql().end({ timeout: 5 });
});

describe("a successful run", () => {
  it("writes chunks and marks the document ready", async () => {
    const { documentId } = await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    const outcome = await processJob(
      { sql: worker, ai: fakeAi(), storage: fakeStorage, workerId: "worker-1" },
      job!,
    );

    expect(outcome).toBe("succeeded");
    expect(await documentStatus(documentId)).toBe("ready");

    const chunks = await worker<{ ordinal: number; content: string }[]>`
      select ordinal, content from document_chunks order by ordinal
    `;

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.content).toContain("access requests");
  });

  it("stores an embedding of the right dimensionality", async () => {
    await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    await processJob(
      { sql: worker, ai: fakeAi(), storage: fakeStorage, workerId: "worker-1" },
      job!,
    );

    const [row] = await worker<{ dims: number }[]>`
      select vector_dims(embedding) as dims from document_chunks limit 1
    `;

    expect(row?.dims).toBe(EMBEDDING_DIMENSIONS);
  });

  it("records the page count on the version", async () => {
    await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    await processJob(
      { sql: worker, ai: fakeAi(), storage: fakeStorage, workerId: "worker-1" },
      job!,
    );

    const [row] = await worker<{ page_count: number }[]>`
      select page_count from document_versions limit 1
    `;

    expect(row?.page_count).toBe(2);
  });

  it("replaces chunks rather than accumulating them when run twice", async () => {
    // Re-indexing must not double every passage; retrieval would then return
    // each one twice and the evidence set would be half wasted.
    const { documentId, versionId } = await seedDocumentWithJob(alpha);

    const first = await claimNextJob(worker, "worker-1");
    await processJob(
      { sql: worker, ai: fakeAi(), storage: fakeStorage, workerId: "worker-1" },
      first!,
    );

    // Re-index this test's version specifically. Earlier tests in this file
    // leave their own documents and versions behind, so an unscoped insert
    // would enqueue those too and this would silently measure the wrong thing.
    await worker`
      insert into ingestion_jobs (organization_id, document_id, document_version_id)
      select organization_id, document_id, id from document_versions
      where id = ${versionId}
    `;

    const second = await claimNextJob(worker, "worker-1");
    await processJob(
      { sql: worker, ai: fakeAi(), storage: fakeStorage, workerId: "worker-1" },
      second!,
    );

    const [{ count }] = await worker<{ count: string }[]>`
      select count(*)::text as count from document_chunks
    `;

    expect(Number(count)).toBe(3);
    expect(await documentStatus(documentId)).toBe("ready");
  });
});

describe("failure handling", () => {
  it("retries a download failure without failing the document", async () => {
    const { documentId } = await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    const outcome = await processJob(
      {
        sql: worker,
        ai: fakeAi(),
        storage: {
          download: async () => {
            throw new Error("network");
          },
        },
        workerId: "worker-1",
      },
      job!,
    );

    expect(outcome).toBe("retry_scheduled");
    // Attempts remain, so the document must not be shown as failed yet.
    expect(await documentStatus(documentId)).toBe("processing");

    const [row] = await worker<{ failure_code: string }[]>`
      select failure_code from ingestion_jobs
    `;
    expect(row?.failure_code).toBe("DOWNLOAD_FAILED");
  });

  it("refuses vectors from a model that is not the configured one", async () => {
    // The deterministic provider used in tests and CI reports its own name.
    // This is what stops meaningless vectors reaching the database.
    await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    const outcome = await processJob(
      {
        sql: worker,
        ai: fakeAi({
          embed: async (texts: string[]) => ({
            model: "deterministic-test-provider",
            dimensions: EMBEDDING_DIMENSIONS,
            vectors: Array.from({ length: texts.length }, () =>
              new Array(EMBEDDING_DIMENSIONS).fill(0.1),
            ),
          }),
        }),
        storage: fakeStorage,
        workerId: "worker-1",
      },
      job!,
    );

    expect(outcome).toBe("retry_scheduled");

    const [{ count }] = await worker<{ count: string }[]>`
      select count(*)::text as count from document_chunks
    `;
    expect(Number(count)).toBe(0);

    const [row] = await worker<{ failure_code: string }[]>`
      select failure_code from ingestion_jobs
    `;
    expect(row?.failure_code).toBe("EMBEDDING_MODEL_MISMATCH");
  });

  it("refuses vectors of the wrong dimensionality", async () => {
    await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    await processJob(
      {
        sql: worker,
        ai: fakeAi({
          embed: async (texts: string[]) => ({
            model: EMBEDDING_MODEL,
            dimensions: 128,
            vectors: Array.from({ length: texts.length }, () => new Array(128).fill(0.1)),
          }),
        }),
        storage: fakeStorage,
        workerId: "worker-1",
      },
      job!,
    );

    const [{ count }] = await worker<{ count: string }[]>`
      select count(*)::text as count from document_chunks
    `;
    expect(Number(count)).toBe(0);
  });

  it("marks the document failed once attempts are exhausted", async () => {
    const { documentId } = await seedDocumentWithJob(alpha);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await claimNextJob(worker, "worker-1");
      expect(job, `expected a job on attempt ${attempt}`).not.toBeNull();

      await processJob(
        {
          sql: worker,
          ai: fakeAi({
            parse: async () => {
              throw new Error("bad pdf");
            },
          }),
          storage: fakeStorage,
          workerId: "worker-1",
        },
        job!,
      );

      await worker`update ingestion_jobs set run_after = now()`;
    }

    expect(await documentStatus(documentId)).toBe("failed");

    const [row] = await worker<{ failure_code: string }[]>`
      select failure_code from documents where id = ${documentId}
    `;
    // A stable code, not a parser message — this is shown to a user.
    expect(row?.failure_code).toBe("PARSE_FAILED");
  });

  it("treats a document with no extractable content as a failure", async () => {
    await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    const outcome = await processJob(
      {
        sql: worker,
        ai: fakeAi({ parse: async () => ({ ...goodParse(0), chunks: [] }) }),
        storage: fakeStorage,
        workerId: "worker-1",
      },
      job!,
    );

    expect(outcome).toBe("retry_scheduled");

    const [row] = await worker<{ failure_code: string }[]>`
      select failure_code from ingestion_jobs
    `;
    expect(row?.failure_code).toBe("NO_CONTENT");
  });

  it("writes no partial chunks when embedding fails midway", async () => {
    // The write happens in one transaction after every batch has embedded, so a
    // half-embedded document leaves nothing behind to retrieve.
    await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    await processJob(
      {
        sql: worker,
        ai: fakeAi({
          embed: async () => {
            throw new Error("model died");
          },
        }),
        storage: fakeStorage,
        workerId: "worker-1",
      },
      job!,
    );

    const [{ count }] = await worker<{ count: string }[]>`
      select count(*)::text as count from document_chunks
    `;
    expect(Number(count)).toBe(0);
  });
});

describe("tenant scoping of derived data", () => {
  it("stores chunks that the owning tenant can read and others cannot", async () => {
    const beta = await createTenant("beta");
    await seedDocumentWithJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    await processJob(
      { sql: worker, ai: fakeAi(), storage: fakeStorage, workerId: "worker-1" },
      job!,
    );

    const mine = await withTenantContext(alpha.claims, (tx) =>
      tx.select({ id: schema.documentChunks.id }).from(schema.documentChunks),
    );
    const theirs = await withTenantContext(beta.claims, (tx) =>
      tx.select({ id: schema.documentChunks.id }).from(schema.documentChunks),
    );

    expect(mine).toHaveLength(3);
    expect(theirs).toEqual([]);
  });
});
