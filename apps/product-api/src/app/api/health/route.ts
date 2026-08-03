import { NextResponse } from "next/server";

/**
 * Liveness probe.
 *
 * Deliberately dependency-free: it answers "is this process serving requests",
 * not "is the database reachable". Readiness lands with the database client in
 * M2, so that a failing dependency degrades a specific endpoint rather than
 * taking the whole deployment out of rotation.
 */
export function GET() {
  return NextResponse.json({
    status: "ok" as const,
    service: "product-api" as const,
    // Reported so a demo deployment can never be mistaken for a local instance
    // handling real documents.
    mode: process.env["CLIENTATLAS_MODE"] ?? "local",
  });
}
