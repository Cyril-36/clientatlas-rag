import { describe, expect, it } from "vitest";

import { isSupportedPgvector, MINIMUM_PGVECTOR } from "@/lib/database/pgvector";

describe("isSupportedPgvector", () => {
  it("accepts the minimum itself", () => {
    expect(isSupportedPgvector(MINIMUM_PGVECTOR.join("."))).toBe(true);
  });

  it("accepts the version the project develops against", () => {
    expect(isSupportedPgvector("0.8.2")).toBe(true);
  });

  it("rejects the last release without iterative scan", () => {
    expect(isSupportedPgvector("0.7.4")).toBe(false);
  });

  it("does not compare versions as text", () => {
    // "0.10.0" < "0.8.0" as a string, which would reject a newer pgvector than
    // the one required. The same mistake in the SQL guard would let an old
    // version through on some inputs and block a new one on others.
    expect(isSupportedPgvector("0.10.0")).toBe(true);
    expect(isSupportedPgvector("0.9.1")).toBe(true);
    expect(isSupportedPgvector("1.0.0")).toBe(true);
  });

  it("treats a missing or unreadable version as unsupported", () => {
    // This decides whether to serve traffic, so the unknown case is the
    // cautious one: a database that cannot say which pgvector it has is not a
    // database this can promise correct retrieval from.
    expect(isSupportedPgvector(undefined)).toBe(false);
    expect(isSupportedPgvector(null)).toBe(false);
    expect(isSupportedPgvector("")).toBe(false);
    expect(isSupportedPgvector("unknown")).toBe(false);
    expect(isSupportedPgvector("0.8.x")).toBe(false);
  });

  it("tolerates a short version string", () => {
    expect(isSupportedPgvector("0.8")).toBe(true);
    expect(isSupportedPgvector("0.7")).toBe(false);
    expect(isSupportedPgvector("1")).toBe(true);
  });
});
