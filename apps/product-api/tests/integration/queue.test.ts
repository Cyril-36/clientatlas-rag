import { randomUUID } from "node:crypto";
import process from "node:process";

import * as schema from "@clientatlas/database/schema";
import {
  backoffSeconds,
  claimNextJob,
  completeJob,
  failJob,
  heartbeat,
  reclaimAbandonedJobs,
} from "@clientatlas/database/queue";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getRuntimeSql } from "@/lib/database/client";
import { withTenantContext } from "@/lib/database/tenant";

import { createTenant, truncateTenantTables, type Tenant } from "./helpers/fixtures";

/**
 * The ingestion queue, against a real PostgreSQL.
 *
 * The properties worth testing here are the concurrent ones, which no amount of
 * single-threaded exercise would reveal: two workers must never receive the
 * same job, and a worker that dies must not strand it.
 */

let alpha: Tenant;
let worker: postgres.Sql;

async function seedJob(tenant: Tenant): Promise<string> {
  // A document and version have to exist: the job carries composite foreign
  // keys to both, which is what stops a job pointing across tenants.
  const documentId = randomUUID();
  const versionId = randomUUID();

  await withTenantContext(tenant.claims, async (tx) => {
    await tx.insert(schema.documents).values({
      id: documentId,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      title: "queue fixture",
      originalFilename: "queue-fixture.pdf",
      mediaType: "application/pdf",
    });

    await tx.insert(schema.documentVersions).values({
      id: versionId,
      organizationId: tenant.organizationId,
      documentId,
      versionNumber: 1,
      storagePath: `organizations/${tenant.organizationId}/workspaces/${tenant.workspaceId}/documents/${documentId}/${versionId}.pdf`,
      byteSize: 10,
      checksumSha256: "a".repeat(64),
    });

    await tx.insert(schema.ingestionJobs).values({
      organizationId: tenant.organizationId,
      documentId,
      documentVersionId: versionId,
    });
  });

  return documentId;
}

beforeAll(async () => {
  await truncateTenantTables();
  alpha = await createTenant("alpha");

  const url = process.env["WORKER_DATABASE_URL"];
  if (!url) {
    throw new Error("WORKER_DATABASE_URL is not set.");
  }

  worker = postgres(url, { max: 5, onnotice: () => {} });
  // The worker role is NOINHERIT, so it must assume its granted role. Unlike a
  // user request there are no claims to set — the worker's policies are keyed
  // on the role itself, not on a JWT subject.
  await worker`set role clientatlas_worker`;
});

beforeEach(async () => {
  await worker`delete from ingestion_jobs`;
});

afterAll(async () => {
  await worker?.end({ timeout: 5 });
  await truncateTenantTables();
  await getRuntimeSql().end({ timeout: 5 });
});

describe("backoffSeconds", () => {
  it("grows exponentially from the base", () => {
    expect(backoffSeconds(1, 30)).toBe(30);
    expect(backoffSeconds(2, 30)).toBe(60);
    expect(backoffSeconds(3, 30)).toBe(120);
  });

  it("is capped", () => {
    expect(backoffSeconds(20, 30, 900)).toBe(900);
  });

  it("never returns zero for a first failure", () => {
    // A zero delay would retry instantly against whatever just failed.
    expect(backoffSeconds(0, 30)).toBeGreaterThan(0);
  });
});

describe("claiming", () => {
  it("claims a queued job and marks it running", async () => {
    await seedJob(alpha);

    const job = await claimNextJob(worker, "worker-1");

    expect(job).not.toBeNull();
    expect(job?.attempts).toBe(1);
    expect(job?.organizationId).toBe(alpha.organizationId);
  });

  it("returns null when nothing is due", async () => {
    expect(await claimNextJob(worker, "worker-1")).toBeNull();
  });

  it("does not claim a job whose backoff has not elapsed", async () => {
    await seedJob(alpha);
    await worker`update ingestion_jobs set run_after = now() + interval '1 hour'`;

    expect(await claimNextJob(worker, "worker-1")).toBeNull();
  });

  it("never hands the same job to two concurrent workers", async () => {
    // The property FOR UPDATE SKIP LOCKED exists for. Three jobs, five workers
    // claiming simultaneously: exactly three claims, all distinct.
    await seedJob(alpha);
    await seedJob(alpha);
    await seedJob(alpha);

    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, index) => claimNextJob(worker, `worker-${index}`)),
    );

    const claimed = claims.filter((job) => job !== null);
    const ids = new Set(claimed.map((job) => job.id));

    expect(claimed).toHaveLength(3);
    expect(ids.size).toBe(3);
  });
});

describe("completion and failure", () => {
  it("marks a job succeeded", async () => {
    await seedJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    await completeJob(worker, job!.id);

    const [row] = await worker<{ status: string }[]>`
      select status from ingestion_jobs where id = ${job!.id}
    `;
    expect(row?.status).toBe("succeeded");
  });

  it("reschedules a failure with backoff instead of retrying immediately", async () => {
    await seedJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    const outcome = await failJob(worker, job!.id, "PARSE_FAILED");

    expect(outcome).toBe("retry_scheduled");

    const [row] = await worker<{ status: string; due_now: boolean }[]>`
      select status, run_after <= now() as due_now
      from ingestion_jobs where id = ${job!.id}
    `;

    expect(row?.status).toBe("queued");
    expect(row?.due_now).toBe(false);
  });

  it("gives up once attempts are exhausted", async () => {
    await seedJob(alpha);

    // Three attempts is the default, so the third failure is terminal.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await claimNextJob(worker, "worker-1");
      expect(job, `expected a claimable job on attempt ${attempt}`).not.toBeNull();

      const outcome = await failJob(worker, job!.id, "PARSE_FAILED");

      if (attempt < 3) {
        expect(outcome).toBe("retry_scheduled");
        await worker`update ingestion_jobs set run_after = now()`;
      } else {
        expect(outcome).toBe("gave_up");
      }
    }

    const [row] = await worker<{ status: string; failure_code: string }[]>`
      select status, failure_code from ingestion_jobs
    `;

    expect(row?.status).toBe("failed");
    expect(row?.failure_code).toBe("PARSE_FAILED");
  });
});

describe("abandoned jobs", () => {
  it("returns a job to the queue when its worker stops reporting", async () => {
    await seedJob(alpha);
    const job = await claimNextJob(worker, "worker-that-died");

    // Simulate the worker disappearing: the claim stands, the heartbeat stops.
    await worker`update ingestion_jobs set heartbeat_at = now() - interval '10 minutes'`;

    const reclaimed = await reclaimAbandonedJobs(worker, 120);

    expect(reclaimed).toBe(1);

    const [row] = await worker<{ status: string; claimed_by: string | null }[]>`
      select status, claimed_by from ingestion_jobs where id = ${job!.id}
    `;

    expect(row?.status).toBe("queued");
    expect(row?.claimed_by).toBeNull();
  });

  it("leaves a healthy running job alone", async () => {
    await seedJob(alpha);
    await claimNextJob(worker, "worker-1");

    expect(await reclaimAbandonedJobs(worker, 120)).toBe(0);
  });

  it("fails an abandoned job that has already used its attempts", async () => {
    // Otherwise a document that reliably kills its worker loops for ever.
    await seedJob(alpha);
    const job = await claimNextJob(worker, "worker-1");

    await worker`
      update ingestion_jobs
      set attempts = max_attempts, heartbeat_at = now() - interval '10 minutes'
    `;

    await reclaimAbandonedJobs(worker, 120);

    const [row] = await worker<{ status: string; failure_code: string }[]>`
      select status, failure_code from ingestion_jobs where id = ${job!.id}
    `;

    expect(row?.status).toBe("failed");
    expect(row?.failure_code).toBe("WORKER_ABANDONED");
  });

  it("refuses a heartbeat from a worker that no longer holds the claim", async () => {
    await seedJob(alpha);
    const job = await claimNextJob(worker, "worker-that-died");

    await worker`update ingestion_jobs set heartbeat_at = now() - interval '10 minutes'`;
    await reclaimAbandonedJobs(worker, 120);
    await claimNextJob(worker, "worker-that-took-over");

    // The original worker must not be able to resurrect its claim while the
    // replacement is midway through the same document.
    expect(await heartbeat(worker, job!.id, "worker-that-died")).toBe(false);
    expect(await heartbeat(worker, job!.id, "worker-that-took-over")).toBe(true);
  });
});
