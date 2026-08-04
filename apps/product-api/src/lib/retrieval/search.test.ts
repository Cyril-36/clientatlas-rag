import { describe, expect, it } from "vitest";

import { fuse, RRF_K } from "./search";

/**
 * Reciprocal rank fusion, in isolation.
 *
 * These need no database and always run. They were previously bundled into the
 * integration file, where they were skipped whenever the corpus had not been
 * seeded — so the one part of retrieval that is pure logic was the part least
 * likely to be exercised.
 */

const row = (id: string) => ({
  chunk_id: id,
  document_id: "d",
  document_title: "t",
  ordinal: 1,
  content: "c",
  page_number: null,
  heading_path: [],
});

describe("fuse", () => {
  it("ranks a chunk found by both searches above one found by either alone", () => {
    // The property that makes fusion worth doing at all. `b` is second in both
    // lists and must beat `a` and `c`, each of which is first in exactly one.
    const ordered = [
      ...fuse([
        [row("a"), row("b")],
        [row("c"), row("b")],
      ]).values(),
    ]
      .sort((x, y) => y.score - x.score)
      .map((v) => v.row.chunk_id);

    expect(ordered[0]).toBe("b");
  });

  it("uses a constant large enough that one first place does not dominate", () => {
    // With a small k, rank 1 in a single list would outweigh rank 2 in both and
    // the hybrid would collapse into whichever search ranked hardest.
    expect(2 * (1 / (RRF_K + 2))).toBeGreaterThan(1 / (RRF_K + 1));
  });

  it("keeps a chunk that only one search found", () => {
    expect([...fuse([[row("a")], [row("b")]]).keys()].sort()).toEqual(["a", "b"]);
  });

  it("records which searches found each chunk", () => {
    const fused = fuse([[row("a")], [row("a")]]);

    expect(fused.get("a")?.ranks).toEqual([1, 1]);
  });

  it("returns nothing for empty inputs rather than throwing", () => {
    expect(fuse([[], []]).size).toBe(0);
  });
});
