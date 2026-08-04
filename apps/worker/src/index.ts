import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DOCUMENTS_BUCKET } from "@clientatlas/contracts";
import { claimNextJob, reclaimAbandonedJobs } from "@clientatlas/database/queue";
import postgres from "postgres";

import { createAiClient, createStorageClient } from "./ai-client";
import { processJob } from "./process-job";

/**
 * The ingestion worker loop.
 *
 * Polls rather than listens. `LISTEN`/`NOTIFY` would cut latency, but polling a
 * partial index every second is negligible at this scale and has one property
 * that matters more: a worker that starts after a job was enqueued still finds
 * it. A missed notification is silent, and silence is the failure mode this
 * whole queue design keeps trying to avoid.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "../../../.env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const POLL_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 3000;
const RECLAIM_INTERVAL_MS = 30_000;

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set.`);
  }

  return value;
}

async function main(): Promise<void> {
  const workerId = `${hostname()}-${process.pid}`;

  // No SET ROLE here, unlike the request path. The worker's privileges are
  // granted directly to clientatlas_worker and its policies target that role,
  // so it already has exactly what it needs on every connection. A SET ROLE
  // would apply to one pooled connection and silently not to the others.
  const sql = postgres(required("WORKER_DATABASE_URL"), { max: 4, onnotice: () => {} });

  const ai = createAiClient(process.env["CLIENTATLAS_AI_URL"] ?? "http://127.0.0.1:8000");
  const storage = createStorageClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    DOCUMENTS_BUCKET,
  );

  let running = true;
  const stop = (): void => {
    running = false;
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.stdout.write(`${JSON.stringify({ event: "worker_started", workerId })}\n`);

  let lastReclaim = 0;

  while (running) {
    const now = Date.now();

    if (now - lastReclaim > RECLAIM_INTERVAL_MS) {
      lastReclaim = now;
      const reclaimed = await reclaimAbandonedJobs(sql);

      if (reclaimed > 0) {
        process.stdout.write(`${JSON.stringify({ event: "jobs_reclaimed", reclaimed })}\n`);
      }
    }

    const job = await claimNextJob(sql, workerId);

    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_INTERVAL_MS));
      continue;
    }

    const outcome = await processJob({ sql, ai, storage, workerId }, job);

    // Structured, and deliberately free of document text, filenames and paths.
    process.stdout.write(
      `${JSON.stringify({
        event: "job_processed",
        jobId: job.id,
        attempt: job.attempts,
        outcome,
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await sql.end({ timeout: 5 });
  process.stdout.write(`${JSON.stringify({ event: "worker_stopped", workerId })}\n`);
}

await main();
