import { describe, expect, it } from "vitest";

import { toEvidence, validateCitations, type EvidenceItem } from "@/lib/generation/citations";
import type { RetrievedChunk } from "@/lib/retrieval/search";

function evidence(count: number): EvidenceItem[] {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    chunkId: `chunk-${index + 1}`,
    documentId: `doc-${index + 1}`,
    documentTitle: `Document ${index + 1}`,
    pageNumber: index + 1,
  }));
}

describe("toEvidence", () => {
  it("numbers from 1 in retrieval order", () => {
    // The ordinal is what the model cites, so it has to be positional and
    // contiguous. Numbering from 0, or by chunk id, would make every citation
    // either off by one or unresolvable.
    const chunks = [
      { chunkId: "b", documentId: "d2", documentTitle: "B", pageNumber: null },
      { chunkId: "a", documentId: "d1", documentTitle: "A", pageNumber: 4 },
    ] as RetrievedChunk[];

    expect(toEvidence(chunks).map((item) => [item.ordinal, item.chunkId])).toEqual([
      [1, "b"],
      [2, "a"],
    ]);
  });
});

describe("validateCitations", () => {
  it("resolves a citation to the chunk it refers to", () => {
    const result = validateCitations("Claims are filed within 30 days [2].", evidence(3));

    expect(result.citations).toEqual([
      {
        ordinal: 2,
        chunkId: "chunk-2",
        documentId: "doc-2",
        documentTitle: "Document 2",
        pageNumber: 2,
      },
    ]);
    expect(result.ungrounded).toBe(false);
  });

  it("reports an ordinal that was never supplied instead of silently dropping it", () => {
    // The central failure mode: the model invents [7] when three passages were
    // given. Dropping it quietly would leave an answer that looks cited and is
    // not, and would hide the best signal that something is wrong upstream.
    const result = validateCitations("The policy is clear [7].", evidence(3));

    expect(result.unresolved).toEqual([7]);
    expect(result.citations).toEqual([]);
    expect(result.ungrounded).toBe(true);
  });

  it("keeps the valid citations from an answer that also invents one", () => {
    const result = validateCitations(
      "Filed within 30 days [2], approved by finance [9].",
      evidence(3),
    );

    expect(result.citations.map((c) => c.ordinal)).toEqual([2]);
    expect(result.unresolved).toEqual([9]);
    expect(result.ungrounded).toBe(false);
  });

  it("treats an answer with no citations as ungrounded", () => {
    const result = validateCitations("The deadline is 30 days.", evidence(3));

    expect(result.citations).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.ungrounded).toBe(true);
  });

  it("lists each source once, in the order a reader meets it", () => {
    const result = validateCitations("First [3]. Second [1]. Again [3].", evidence(3));

    expect(result.citations.map((c) => c.ordinal)).toEqual([3, 1]);
  });

  it("does not invent a citation from prose that merely contains brackets", () => {
    // Retrieved text is documentation, and documentation contains items[0] and
    // matrix[2]. An answer quoting a line of config must not thereby cite
    // whichever passage carries that number. Caught by this test against the
    // first version of the parser, which read items[0] as a citation.
    const result = validateCitations(
      "The config uses items[0] and matrix[2] and a range [1-2] and a note [a].",
      evidence(3),
    );

    expect(result.citations).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("still reads a citation after ordinary punctuation", () => {
    // The lookbehind must exclude identifiers without excluding the normal
    // case, which is a marker after a space, a full stop or a comma.
    expect(validateCitations("Filed within 30 days [2].", evidence(3)).citations).toHaveLength(1);
    expect(validateCitations("[2] says so.", evidence(3)).citations).toHaveLength(1);
    expect(validateCitations("Approved,[2] then filed.", evidence(3)).citations).toHaveLength(1);
  });

  it("ignores a citation of zero", () => {
    // Evidence is numbered from 1, so [0] refers to nothing. It is reported as
    // unresolved rather than resolved to the first passage, which is what an
    // off-by-one would do.
    const result = validateCitations("See [0].", evidence(3));

    expect(result.citations).toEqual([]);
    expect(result.unresolved).toEqual([0]);
  });

  it("handles adjacent citations for a claim drawn from two passages", () => {
    const result = validateCitations("Both agree [1][3].", evidence(3));

    expect(result.citations.map((c) => c.ordinal)).toEqual([1, 3]);
  });
});
