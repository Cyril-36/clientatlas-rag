import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIMENSIONS,
  resultFor,
  score,
  toSections,
  type DimensionResult,
} from "@/lib/artifacts/readiness";
import type { AnswerEvent } from "@/lib/generation/answer";

const dimension = { key: "expenses", heading: "Expenses", probe: "How are expenses claimed?" };

const citation = {
  ordinal: 1,
  chunkId: "chunk-1",
  documentId: "doc-1",
  documentTitle: "Expenses handbook",
  pageNumber: 4,
};

function answered(text: string): AnswerEvent[] {
  return [
    { type: "token", text },
    { type: "done", citations: [citation] },
  ];
}

describe("resultFor", () => {
  it("counts a cited answer as covered", () => {
    const result = resultFor(dimension, answered("Filed within 30 days [1]."));

    expect(result.coverage).toBe("covered");
    expect(result.summary).toBe("Filed within 30 days [1].");
    expect(result.citations).toEqual([citation]);
  });

  it("counts an abstention as missing, in the generator's own words", () => {
    const result = resultFor(dimension, [
      { type: "abstained", reason: "The evidence does not answer the question." },
    ]);

    expect(result.coverage).toBe("missing");
    expect(result.note).toBe("The evidence does not answer the question.");
    expect(result.summary).toBe("");
  });

  it("counts an error as unavailable, not as missing", () => {
    // The distinction the score depends on. A model service that was down says
    // nothing about whether the documents cover the topic, and reporting it as
    // a gap would invent one.
    const result = resultFor(dimension, [
      { type: "error", code: "generation_unavailable", message: "the model service is down" },
    ]);

    expect(result.coverage).toBe("unavailable");
    expect(result.note).toContain("the model service is down");
  });

  it("counts a stream that ended without a terminal frame as unavailable", () => {
    expect(resultFor(dimension, [{ type: "token", text: "half an ans" }]).coverage).toBe(
      "unavailable",
    );
    expect(resultFor(dimension, []).coverage).toBe("unavailable");
  });

  it("refuses to count an uncited answer as covered", () => {
    // The answer path abstains before emitting a citation-free `done`, so this
    // should be unreachable. It is checked anyway: an uncited paragraph in a
    // readiness report is exactly the confident, unsourced claim the system
    // exists to prevent, and this module must not rely on someone else's
    // invariant to avoid producing one.
    const result = resultFor(dimension, [
      { type: "token", text: "Everything is fine." },
      { type: "done", citations: [] },
    ]);

    expect(result.coverage).toBe("missing");
    expect(result.summary).toBe("");
  });
});

describe("score", () => {
  const of = (...coverages: DimensionResult["coverage"][]): DimensionResult[] =>
    coverages.map((coverage, index) => ({
      key: `k${index}`,
      heading: "H",
      probe: "p",
      coverage,
      summary: "",
      citations: [],
      note: "",
    }));

  it("counts covered against what was assessed", () => {
    expect(score(of("covered", "covered", "missing"))).toMatchObject({
      covered: 2,
      missing: 1,
      assessed: 3,
      ratio: 2 / 3,
    });
  });

  it("keeps unavailable out of both counts", () => {
    // Folding a failed assessment into "missing" would report a gap the
    // documents may not have — the report would get worse when the model
    // service had a bad day.
    const totals = score(of("covered", "missing", "unavailable", "unavailable"));

    expect(totals).toMatchObject({ covered: 1, missing: 1, unavailable: 2, assessed: 2 });
    expect(totals.ratio).toBe(0.5);
  });

  it("reports no ratio when nothing could be assessed", () => {
    // Rather than 0, which reads as "nothing is documented" when the truth is
    // "nothing was checked".
    expect(score(of("unavailable", "unavailable")).ratio).toBeNull();
  });

  it("scores an empty report without dividing by zero", () => {
    expect(score([])).toMatchObject({ covered: 0, assessed: 0, ratio: null });
  });
});

describe("toSections", () => {
  it("puts the answer in a covered section and the reason in a missing one", () => {
    const results = [
      resultFor(dimension, answered("Filed within 30 days [1].")),
      resultFor({ key: "leave", heading: "Leave", probe: "How is leave requested?" }, [
        { type: "abstained", reason: "Nothing in this workspace covers leave." },
      ]),
    ];

    const sections = toSections(results, score(results));

    expect(sections.map((s) => s.key)).toEqual(["summary", "expenses", "leave"]);
    expect(sections[1]?.body).toBe("Filed within 30 days [1].");
    expect(sections[2]?.body).toBe("Nothing in this workspace covers leave.");
  });

  it("says what the numbers do not mean", () => {
    const results = [resultFor(dimension, answered("Filed within 30 days [1]."))];
    const [summary] = toSections(results, score(results));

    // A bare "1 of 1" invites reading the score as a grade. The sentence about
    // weighting is the honest part and must not be dropped as boilerplate.
    expect(summary?.body).toContain("1 of 1");
    expect(summary?.body).toContain("not weighted");
  });

  it("says explicitly when something could not be assessed", () => {
    const results = [resultFor(dimension, [{ type: "error", code: "x", message: "unreachable" }])];

    expect(toSections(results, score(results))[0]?.body).toContain("could not be assessed");
  });
});

describe("the default dimensions", () => {
  it("has unique keys, since a key identifies a section and its evidence", () => {
    const keys = DEFAULT_DIMENSIONS.map((d) => d.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not collide with the summary section's key", () => {
    expect(DEFAULT_DIMENSIONS.some((d) => d.key === "summary")).toBe(false);
  });

  it("asks questions rather than naming topics", () => {
    // Retrieval is built for questions. A dimension whose probe is a noun
    // phrase retrieves badly and then reports a gap that is really a statement
    // about the probe.
    for (const d of DEFAULT_DIMENSIONS) expect(d.probe).toMatch(/\?$/);
  });
});
