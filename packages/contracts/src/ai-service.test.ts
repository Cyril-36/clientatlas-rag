import { describe, expect, it } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  embedResponseSchema,
  generateRequestSchema,
  type Evidence,
} from "./ai-service";

const evidence = (ordinal: number): Evidence => ({
  ordinal,
  chunkId: `chunk-${ordinal}`,
  text: "Access requests go through the platform team.",
  documentTitle: "Security handbook",
  pageNumber: 4,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  question: "How do I request production access?",
  evidence: [evidence(1), evidence(2)],
  policy: {
    provider: "local-ollama",
    maxOutputTokens: 512,
    temperature: 0.1,
    requireCitations: true,
    allowHostedProvider: false,
  },
  ...overrides,
});

describe("generateRequestSchema", () => {
  it("accepts a local request with contiguous evidence", () => {
    expect(generateRequestSchema.safeParse(request()).success).toBe(true);
  });

  it("rejects a hosted provider when hosted providers are not allowed", () => {
    const result = generateRequestSchema.safeParse(
      request({
        policy: {
          provider: "groq",
          maxOutputTokens: 512,
          temperature: 0.1,
          requireCitations: true,
          allowHostedProvider: false,
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["policy", "provider"]);
  });

  it("accepts a hosted provider once explicitly allowed", () => {
    const result = generateRequestSchema.safeParse(
      request({
        policy: {
          provider: "groq",
          maxOutputTokens: 512,
          temperature: 0.1,
          requireCitations: true,
          allowHostedProvider: true,
        },
      }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects duplicate evidence ordinals", () => {
    const result = generateRequestSchema.safeParse(
      request({ evidence: [evidence(1), evidence(1)] }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/unique/);
  });

  it("rejects non-contiguous evidence ordinals", () => {
    const result = generateRequestSchema.safeParse(
      request({ evidence: [evidence(1), evidence(3)] }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/contiguous/);
  });

  it("rejects an empty evidence set", () => {
    const result = generateRequestSchema.safeParse(request({ evidence: [] }));

    expect(result.success).toBe(false);
  });
});

describe("embedResponseSchema", () => {
  it("rejects a vector of the wrong dimensionality", () => {
    const result = embedResponseSchema.safeParse({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      dimensions: EMBEDDING_DIMENSIONS,
      vectors: [new Array(128).fill(0)],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a correctly sized vector", () => {
    const result = embedResponseSchema.safeParse({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      dimensions: EMBEDDING_DIMENSIONS,
      vectors: [new Array(EMBEDDING_DIMENSIONS).fill(0.1)],
    });

    expect(result.success).toBe(true);
  });
});
