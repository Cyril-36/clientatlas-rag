import {
  embedResponseSchema,
  EMBEDDING_MODEL,
  generationEventSchema,
  type GenerationEvent,
} from "@clientatlas/contracts";

import { getServerEnv } from "@/lib/env";
import type { EvidenceItem } from "@/lib/generation/citations";

/**
 * The client for the model service's streaming generation endpoint.
 *
 * It parses server-sent events into contract-validated frames. Validation is
 * not ceremony: this is a process boundary, the frames drive what a user sees,
 * and an unrecognised frame shape should stop the stream rather than be
 * forwarded on the assumption that it is probably fine.
 */

export interface GenerateOptions {
  readonly question: string;
  readonly evidence: readonly EvidenceItem[];
  readonly texts: ReadonlyMap<string, string>;
  readonly provider?: "local-ollama" | "deterministic-demo";
  readonly signal?: AbortSignal;
}

export class GenerationServiceError extends Error {}

/**
 * Split a byte stream into SSE frames.
 *
 * Kept separate from the request so it can be tested against a handwritten
 * stream, including the case a naive implementation gets wrong: a frame
 * arriving in two chunks, split anywhere, including mid-delimiter.
 */
export async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<GenerationEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames end at a blank line. Anything after the last one is a partial
      // frame and stays in the buffer until the rest of it arrives.
      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        const line = frame.split("\n").find((part) => part.startsWith("data: "));
        if (!line) continue;

        let payload: unknown;

        try {
          payload = JSON.parse(line.slice("data: ".length));
        } catch {
          throw new GenerationServiceError("the model service sent a frame that is not JSON");
        }

        const parsed = generationEventSchema.safeParse(payload);

        if (!parsed.success) {
          throw new GenerationServiceError(
            "the model service sent a frame that does not match the contract",
          );
        }

        yield parsed.data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* generate(options: GenerateOptions): AsyncGenerator<GenerationEvent> {
  const env = getServerEnv();

  const response = await fetch(`${env.AI_SERVICE_URL}/v1/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      question: options.question,
      evidence: options.evidence.map((item) => ({
        ordinal: item.ordinal,
        chunkId: item.chunkId,
        // The text is sent from here rather than held by the model service,
        // which stores nothing between requests and has no way to look a chunk
        // up. It is also why this call is the only place tenant content
        // crosses the boundary, and why the provider policy is enforced on
        // both sides of it.
        text: options.texts.get(item.chunkId) ?? "",
        documentTitle: item.documentTitle,
        pageNumber: item.pageNumber,
      })),
      policy: {
        provider: options.provider ?? "local-ollama",
        requireCitations: true,
        // Never set from a request. A hosted provider is a decision about
        // where a tenant's documents are allowed to travel, and it is not one
        // an HTTP caller gets to make.
        allowHostedProvider: false,
      },
    }),
  });

  if (!response.ok || !response.body) {
    throw new GenerationServiceError(
      `the model service returned ${response.status} and no usable stream`,
    );
  }

  yield* parseEventStream(response.body);
}

/**
 * Embed a question so it can be compared against chunk vectors.
 *
 * The model lives in the AI service, so this is a round trip rather than a
 * local call. It must use the same model the chunks were embedded with — a
 * question embedded by a different model produces distances that are
 * arithmetically valid and semantically meaningless — and the contract pins the
 * model name to a literal so that mismatch is a parse failure, not a subtly
 * worse set of results.
 */
export async function embedQuestion(question: string, signal?: AbortSignal): Promise<number[]> {
  const env = getServerEnv();

  const response = await fetch(`${env.AI_SERVICE_URL}/v1/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ texts: [question] }),
  });

  if (!response.ok) {
    throw new GenerationServiceError(`the model service returned ${response.status} for /v1/embed`);
  }

  // The contract pins `model` to a literal, so a service that answered with
  // deterministic vectors, or with a different sentence-transformer, fails here
  // rather than returning distances that are arithmetically fine and
  // semantically meaningless.
  const parsed = embedResponseSchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new GenerationServiceError(
      `the model service returned an embedding off-contract, which includes embedding with ` +
        `a model other than ${EMBEDDING_MODEL}`,
    );
  }

  const vector = parsed.data.vectors[0];

  if (!vector) {
    throw new GenerationServiceError("the model service returned no embedding for the question");
  }

  return vector;
}
