import { answer, toFrame } from "@/lib/generation/answer";
import { embedQuestion, GenerationServiceError } from "@/lib/generation/client";
import { withAuthenticatedRequest } from "@/lib/http/request-context";
import { errorResponse } from "@/lib/http/responses";

/**
 * Ask a question of a workspace, and stream a grounded answer back.
 *
 * Server-sent events, but **not** progressive rendering, and the difference is
 * worth stating because the two usually come together.
 *
 * Citation validity is a property of the finished answer: whether a `[7]` was
 * invented cannot be known until the sentence containing it exists. So tokens
 * are withheld until the whole answer has passed validation, and a reader sees
 * nothing and then everything. That is slower to look at and it is the only
 * honest option — an abstention that arrives after the ungrounded paragraph has
 * already been displayed has not withheld anything.
 *
 * The transport stays SSE anyway: it carries the terminal frame that says which
 * of the three outcomes happened, it keeps the connection open across a
 * generation that takes seconds without a client-side timeout guess, and it is
 * what a future incremental design would need. Nothing here promises words
 * appearing as they are written, and a client should not render a progress
 * animation implying it.
 *
 * The frames are the caller's contract: `token` frames for an answer that has
 * already passed citation validation, then exactly one terminal frame — `done`
 * with resolved citations, `abstained` with a reason, or `error`.
 */

interface RouteParams {
  readonly params: Promise<{ workspaceId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUESTION_LENGTH = 2000;

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { workspaceId } = await params;

    if (!UUID_PATTERN.test(workspaceId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid workspace id.", context.requestId);
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return errorResponse("VALIDATION_FAILED", "Body must be JSON.", context.requestId);
    }

    const question = (body as { question?: unknown }).question;

    if (typeof question !== "string" || question.trim().length === 0) {
      return errorResponse("VALIDATION_FAILED", "A question is required.", context.requestId);
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      return errorResponse(
        "VALIDATION_FAILED",
        `A question may be at most ${MAX_QUESTION_LENGTH} characters.`,
        context.requestId,
      );
    }

    // Embedding happens before the stream opens, deliberately. It is the one
    // step that can fail in a way the caller can act on — the model service
    // being down — and reporting that as an HTTP error is more useful than a
    // 200 whose first frame is an apology.
    let questionEmbedding: number[];

    try {
      questionEmbedding = await embedQuestion(question, request.signal);
    } catch (error) {
      if (error instanceof GenerationServiceError) {
        return errorResponse("PROVIDER_UNAVAILABLE", error.message, context.requestId);
      }
      throw error;
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          for await (const event of answer(context.claims, {
            workspaceId,
            question,
            questionEmbedding,
            signal: request.signal,
          })) {
            controller.enqueue(encoder.encode(toFrame(event)));
          }
        } catch (error) {
          // The stream has already been given a 200, so a failure here cannot
          // become a status code. It becomes a terminal error frame, which the
          // client contract already requires it to handle.
          controller.enqueue(
            encoder.encode(
              toFrame({
                type: "error",
                code: "internal_error",
                message:
                  error instanceof GenerationServiceError
                    ? error.message
                    : "the answer could not be completed",
              }),
            ),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Without this a reverse proxy buffers the whole stream and delivers
        // it at the end, which is indistinguishable from a hang.
        "x-accel-buffering": "no",
        "x-request-id": context.requestId,
      },
    });
  });
}
