import { NextResponse } from "next/server";

import { getRuntimeSql } from "@/lib/database/client";

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

  try {
    // The probe must fail fast. Without a timeout an unreachable database makes
    // the readiness check itself hang, and an orchestrator waiting on it cannot
    // tell "starting" from "wedged".
    await Promise.race([
      getRuntimeSql()`select 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    databaseReachable = true;
  } catch {
    databaseReachable = false;
  }

  return NextResponse.json(
    {
      status: databaseReachable ? "ok" : "degraded",
      service: "product-api",
      mode: process.env["CLIENTATLAS_MODE"] ?? "local",
      checks: { database: databaseReachable },
      durationMs: Date.now() - startedAt,
    },
    { status: databaseReachable ? 200 : 503 },
  );
}
