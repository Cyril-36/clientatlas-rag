import { NextResponse } from "next/server";

import { getRuntimeSql } from "@/lib/database/client";
import { isSupportedPgvector } from "@/lib/database/pgvector";

/**
 * Readiness.
 *
 * Distinct from `/api/health`, which is liveness and answers only "is this
 * process serving requests". This one answers "can it do useful work", which
 * means actually reaching the database rather than reporting what was
 * configured. A readiness probe that only reads its own settings will happily
 * report ready while every request 500s.
 *
 * Deliberately unauthenticated — a probe cannot hold a user token — so it must
 * reveal nothing. No host, no role, no driver error text: a failure is a
 * boolean and a duration.
 */
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 2000;

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();
  let databaseReachable = false;
  let vectorSearchSupported = false;

  try {
    // The probe must fail fast. Without a timeout an unreachable database makes
    // the readiness check itself hang, and an orchestrator waiting on it cannot
    // tell "starting" from "wedged".
    const rows = (await Promise.race([
      getRuntimeSql()<{ extversion: string }[]>`
        select extversion from pg_extension where extname = 'vector'
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ])) as { extversion: string }[];

    databaseReachable = true;
    vectorSearchSupported = isSupportedPgvector(rows[0]?.extversion);
  } catch {
    databaseReachable = false;
  }

  const ready = databaseReachable && vectorSearchSupported;

  return NextResponse.json(
    {
      status: ready ? "ok" : "degraded",
      service: "product-api",
      mode: process.env["CLIENTATLAS_MODE"] ?? "local",
      // Booleans only. This endpoint is unauthenticated, so it reports whether
      // a requirement is met and never which version failed to meet it.
      checks: { database: databaseReachable, vectorSearch: vectorSearchSupported },
      durationMs: Date.now() - startedAt,
    },
    { status: ready ? 200 : 503 },
  );
}
