import { z } from "zod";

/**
 * The Node → Python model-service boundary.
 *
 * The AI service is a *pure model service*. It parses bytes, embeds text and
 * generates tokens. It holds no database credentials, opens no transaction and
 * runs no tenant query — the Next.js application owns every tenant-scoped SQL
 * statement, including the pgvector search. That keeps the RLS transaction
 * contract (verify JWT → set claims → `set local role authenticated`) written
 * once, in one language, with one test suite.
 *
 * Consequently nothing on this boundary is authorization-bearing. `chunkId` is
 * carried through so the caller can map a citation back to a row, but the model
 * service never reads it, never resolves it and must never be trusted to filter
 * on it. Tenant scoping has already happened by the time evidence gets here.
 */

export const EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

export const SUPPORTED_MEDIA_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export const mediaTypeSchema = z.enum(SUPPORTED_MEDIA_TYPES);
export type SupportedMediaType = z.infer<typeof mediaTypeSchema>;

/* -------------------------------------------------------------------------- */
/* Embedding                                                                  */
/* -------------------------------------------------------------------------- */

export const embedRequestSchema = z.object({
  texts: z.array(z.string().min(1)).min(1).max(64),
});

export const embedResponseSchema = z.object({
  model: z.literal(EMBEDDING_MODEL),
  dimensions: z.literal(EMBEDDING_DIMENSIONS),
  vectors: z.array(z.array(z.number()).length(EMBEDDING_DIMENSIONS)),
});

export type EmbedRequest = z.infer<typeof embedRequestSchema>;
export type EmbedResponse = z.infer<typeof embedResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

export const parseRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  mediaType: mediaTypeSchema,
  contentBase64: z.string().min(1),
});

export const parsedBlockSchema = z.object({
  /** Position of this block within the document, starting at 1. */
  ordinal: z.number().int().min(1),
  text: z.string().min(1),
  /** Null for formats with no page concept, or when the parser cannot tell. */
  pageNumber: z.number().int().min(1).nullable(),
  /** Outermost heading first, e.g. ["Security", "Access requirements"]. */
  headingPath: z.array(z.string()),
});

export const parseResponseSchema = z.object({
  blocks: z.array(parsedBlockSchema),
  pageCount: z.number().int().min(0),
  /** Computed over the raw bytes, for de-duplication and version identity. */
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ParseRequest = z.infer<typeof parseRequestSchema>;
export type ParsedBlock = z.infer<typeof parsedBlockSchema>;
export type ParseResponse = z.infer<typeof parseResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

export const generationProviderSchema = z.enum(["local-ollama", "groq", "deterministic-demo"]);
export type GenerationProvider = z.infer<typeof generationProviderSchema>;

export const evidenceSchema = z.object({
  /** The number the model must cite, e.g. `[2]`. Contiguous from 1. */
  ordinal: z.number().int().min(1),
  /** Opaque to the model service; used by the caller to resolve a citation. */
  chunkId: z.string().min(1),
  text: z.string().min(1),
  documentTitle: z.string().min(1),
  pageNumber: z.number().int().min(1).nullable(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export const generationPolicySchema = z.object({
  provider: generationProviderSchema,
  maxOutputTokens: z.number().int().min(64).max(2048).default(512),
  temperature: z.number().min(0).max(1).default(0.1),
  /** When true, an answer without resolvable citations is replaced by an abstention. */
  requireCitations: z.boolean().default(true),
  /**
   * Set only for workspaces explicitly marked synthetic. Confidential content
   * must never reach a hosted provider, and there is no fallback path from
   * confidential mode to one.
   */
  allowHostedProvider: z.boolean().default(false),
});

export type GenerationPolicy = z.infer<typeof generationPolicySchema>;

export const generateRequestSchema = z
  .object({
    question: z.string().min(1).max(2000),
    evidence: z.array(evidenceSchema).min(1).max(12),
    policy: generationPolicySchema,
  })
  .superRefine((value, ctx) => {
    if (value.policy.provider === "groq" && !value.policy.allowHostedProvider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy", "provider"],
        message:
          "Hosted provider requested without allowHostedProvider. Confidential content must not leave the local machine.",
      });
    }

    const ordinals = value.evidence.map((item) => item.ordinal);
    const expected = ordinals.length;
    const unique = new Set(ordinals);

    if (unique.size !== ordinals.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "Evidence ordinals must be unique; citations would otherwise be ambiguous.",
      });
      return;
    }

    for (let n = 1; n <= expected; n += 1) {
      if (!unique.has(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence"],
          message: `Evidence ordinals must be contiguous from 1 to ${expected}; ${n} is missing.`,
        });
        return;
      }
    }
  });

export type GenerateRequest = z.infer<typeof generateRequestSchema>;

/** One frame of the SSE stream returned by the generation endpoint. */
export const generationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({
    type: z.literal("done"),
    citedOrdinals: z.array(z.number().int().min(1)),
    outputTokens: z.number().int().min(0),
  }),
  z.object({ type: z.literal("abstained"), reason: z.string().min(1) }),
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string().min(1) }),
]);

export type GenerationEvent = z.infer<typeof generationEventSchema>;
