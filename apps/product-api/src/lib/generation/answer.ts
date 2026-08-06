import { withTenantContext } from "@/lib/database/tenant";
import { toEvidence, validateCitations, type EvidenceItem } from "@/lib/generation/citations";
import { generate, GenerationServiceError } from "@/lib/generation/client";
import { DEFAULT_EVIDENCE_SIZE, hybridSearch } from "@/lib/retrieval/search";
import type { VerifiedClaims } from "@/lib/auth/claims";

/**
 * Retrieve, generate, validate.
 *
 * The order matters and the last step is the point. Retrieval happens under
 * row-level security in this process; generation happens in a service with no
 * database access; validation happens back here, against the evidence this
 * process retrieved, because that is the only place both the answer text and
 * the tenant's real chunk ids exist at once.
 *
 * An answer whose citations do not resolve is not returned as an answer. That
 * is the whole product: a paragraph nobody can check is something any chat
 * interface can already produce.
 */

/** What the caller sees, one frame at a time. */
export type AnswerEvent =
  | { readonly type: "token"; readonly text: string }
  | {
      readonly type: "done";
      readonly citations: ReturnType<typeof validateCitations>["citations"];
      readonly unresolved: number[];
    }
  | { readonly type: "abstained"; readonly reason: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface AnswerOptions {
  readonly workspaceId: string;
  readonly question: string;
  readonly questionEmbedding: number[];
  readonly provider?: "local-ollama" | "deterministic-demo";
  readonly signal?: AbortSignal;
}

interface Retrieved {
  readonly evidence: EvidenceItem[];
  readonly texts: Map<string, string>;
}

async function retrieve(claims: VerifiedClaims, options: AnswerOptions): Promise<Retrieved> {
  const chunks = await withTenantContext(claims, (tx) =>
    hybridSearch(tx, {
      workspaceId: options.workspaceId,
      query: options.question,
      queryEmbedding: options.questionEmbedding,
      limit: DEFAULT_EVIDENCE_SIZE,
    }),
  );

  return {
    evidence: toEvidence(chunks),
    texts: new Map(chunks.map((chunk) => [chunk.chunkId, chunk.content])),
  };
}

export async function* answer(
  claims: VerifiedClaims,
  options: AnswerOptions,
): AsyncGenerator<AnswerEvent> {
  const { evidence, texts } = await retrieve(claims, options);

  // Nothing retrieved means nothing to ground an answer in, and the model is
  // not asked. Sending it an empty evidence list and hoping it declines would
  // be paying for a request whose best possible outcome is this message.
  if (evidence.length === 0) {
    yield {
      type: "abstained",
      reason:
        "No passage in this workspace matched the question, so there is nothing to answer from.",
    };
    return;
  }

  const pieces: string[] = [];

  try {
    for await (const event of generate({
      question: options.question,
      evidence,
      texts,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      switch (event.type) {
        case "token":
          pieces.push(event.text);
          yield { type: "token", text: event.text };
          break;

        case "abstained":
          yield { type: "abstained", reason: event.reason };
          return;

        case "error":
          yield { type: "error", code: event.code, message: event.message };
          return;

        case "done":
          // `event.citedOrdinals` is deliberately ignored. It is the model
          // service's reading of text the model produced, and this process has
          // something better: the evidence it actually retrieved.
          break;
      }
    }
  } catch (error) {
    yield {
      type: "error",
      code: "generation_unavailable",
      message:
        error instanceof GenerationServiceError
          ? error.message
          : "the model service could not be reached",
    };
    return;
  }

  const validated = validateCitations(pieces.join(""), evidence);

  if (validated.ungrounded) {
    yield {
      type: "abstained",
      reason:
        "The answer cited no passage from this workspace, so none of it can be traced to a " +
        "document. It has been withheld rather than shown unsourced.",
    };
    return;
  }

  yield { type: "done", citations: validated.citations, unresolved: validated.unresolved };
}

/**
 * Serialise an event as an SSE frame.
 *
 * `JSON.stringify` rather than string building: an answer containing a newline
 * would otherwise split into two frames, and the second would be parsed as a
 * new event.
 */
export function toFrame(event: AnswerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
