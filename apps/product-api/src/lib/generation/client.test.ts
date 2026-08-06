import { describe, expect, it } from "vitest";

import { GenerationServiceError, parseEventStream } from "@/lib/generation/client";

/** A stream that delivers exactly the chunks given, in order. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of parseEventStream(stream)) events.push(event);
  return events;
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

describe("parseEventStream", () => {
  it("reads whole frames", async () => {
    const events = await collect(
      streamOf(
        frame({ type: "token", text: "Filed " }),
        frame({ type: "token", text: "within 30 days [1]." }),
        frame({ type: "done", citedOrdinals: [1], outputTokens: 5 }),
      ),
    );

    expect(events.map((event) => event.type)).toEqual(["token", "token", "done"]);
  });

  it("reassembles a frame split across chunks", async () => {
    // Network chunks do not respect frame boundaries. An implementation that
    // parses each chunk on its own drops or corrupts whatever straddles them,
    // and the symptom is words missing from the middle of an answer.
    const whole = frame({ type: "token", text: "within 30 days" });
    const split = Math.floor(whole.length / 2);

    const events = await collect(streamOf(whole.slice(0, split), whole.slice(split)));

    expect(events).toEqual([{ type: "token", text: "within 30 days" }]);
  });

  it("reassembles a frame split inside the delimiter", async () => {
    // The nastiest boundary: the two newlines that end a frame arrive in
    // different chunks, so neither chunk contains a complete terminator.
    const whole = frame({ type: "token", text: "hello" });
    const cut = whole.length - 1;

    const events = await collect(streamOf(whole.slice(0, cut), whole.slice(cut)));

    expect(events).toEqual([{ type: "token", text: "hello" }]);
  });

  it("reads several frames arriving in one chunk", async () => {
    const events = await collect(
      streamOf(frame({ type: "token", text: "a" }) + frame({ type: "token", text: "b" })),
    );

    expect(events.map((event) => event.type)).toEqual(["token", "token"]);
  });

  it("preserves a newline inside an answer", async () => {
    // Answers contain paragraph breaks. Building frames by hand rather than
    // with JSON would split one here and parse the remainder as a new event.
    const events = await collect(streamOf(frame({ type: "token", text: "one\n\ntwo" })));

    expect(events).toEqual([{ type: "token", text: "one\n\ntwo" }]);
  });

  it("refuses a frame that does not match the contract", async () => {
    // A process boundary. An unrecognised frame stops the stream rather than
    // being forwarded on the assumption it is probably fine.
    await expect(collect(streamOf(frame({ type: "surprise", text: "x" })))).rejects.toThrow(
      GenerationServiceError,
    );
  });

  it("refuses a frame that is not JSON", async () => {
    await expect(collect(streamOf("data: not json at all\n\n"))).rejects.toThrow(
      GenerationServiceError,
    );
  });

  it("ignores comments and other non-data lines", async () => {
    // SSE allows keep-alive comments, and a proxy may inject them. Treating
    // one as a malformed frame would kill an otherwise healthy stream.
    const events = await collect(streamOf(": keep-alive\n\n", frame({ type: "token", text: "a" })));

    expect(events).toEqual([{ type: "token", text: "a" }]);
  });

  it("drops a trailing partial frame rather than inventing one", async () => {
    // A connection cut mid-frame must not produce a half-parsed event. The
    // caller sees no terminal frame, which is the honest signal.
    const events = await collect(
      streamOf(frame({ type: "token", text: "a" }), 'data: {"type":"to'),
    );

    expect(events).toEqual([{ type: "token", text: "a" }]);
  });
});
