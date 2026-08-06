import type { RetrievedChunk } from "@/lib/retrieval/search";

/**
 * Citation validation, done here because here is where the truth is.
 *
 * The model service already reports which ordinals it saw in its own output,
 * and that report is not evidence of anything. It is derived from the same text
 * the model produced, by a service that never held a chunk id and cannot check
 * a claim against a tenant's documents. Treating it as authoritative would mean
 * the only thing standing between a hallucinated `[7]` and a user is the
 * component that produced it.
 *
 * So the answer text is re-parsed against the evidence this process retrieved
 * under row-level security. An ordinal outside that set resolves to nothing —
 * whatever the model service said about it.
 */

/** Evidence as it was numbered for the model. */
export interface EvidenceItem {
  readonly ordinal: number;
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly pageNumber: number | null;
}

/** A citation that resolved to a real, retrieved chunk. */
export interface ResolvedCitation {
  readonly ordinal: number;
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly pageNumber: number | null;
}

export interface ValidatedAnswer {
  /** Citations that resolve to evidence actually sent. */
  readonly citations: ResolvedCitation[];
  /**
   * Ordinals the answer cited that were never supplied. Non-empty means the
   * model invented a source, which is worth surfacing rather than discarding:
   * it is the single most useful signal about a model or prompt going wrong.
   */
  readonly unresolved: number[];
  /** True when nothing in the answer can be traced to a document. */
  readonly ungrounded: boolean;
}

/**
 * `[3]`, and only that, and only where a marker could plausibly stand.
 *
 * Deliberately narrow. Accepting `[3, 4]` or `[Smith 2019]` would mean guessing
 * at intent, and a citation parser that guesses produces confident links to the
 * wrong passage — worse than no link, because it looks checked.
 *
 * The lookbehind is not decoration. Retrieved passages are documentation, and
 * documentation contains `items[0]`, `argv[1]`, `matrix[2]`. Without it, an
 * answer quoting a line of config produces a citation of whichever passage
 * happens to carry that number — a fabricated source, in an answer whose whole
 * purpose is that its sources are real.
 *
 * It costs the case where a model writes `30 days[2]` with no space, which is
 * then read as no citation at all. That is the right direction to fail in: the
 * answer is treated as ungrounded and refused, rather than shown with a source
 * it never claimed.
 *
 * Only a word character disqualifies a marker, not a closing bracket. `[1][3]`
 * is the form the prompt asks for when a claim rests on two passages, so
 * excluding a `[` that follows `]` would silently drop the second half of every
 * multi-source citation — which an earlier version of this regex did, and which
 * the adjacent-citation test below caught.
 */
const CITATION = /(?<!\w)\[(\d{1,3})\]/g;

/** Build the evidence list handed to the model, numbered from 1. */
export function toEvidence(chunks: readonly RetrievedChunk[]): EvidenceItem[] {
  return chunks.map((chunk, index) => ({
    ordinal: index + 1,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    pageNumber: chunk.pageNumber,
  }));
}

/**
 * Resolve every citation in `answer` against `evidence`.
 *
 * Order is the order of first appearance in the text, not numeric order: a
 * reader following a footnote list expects it to run in the order they met the
 * markers.
 */
export function validateCitations(
  answer: string,
  evidence: readonly EvidenceItem[],
): ValidatedAnswer {
  const byOrdinal = new Map(evidence.map((item) => [item.ordinal, item]));

  const citations: ResolvedCitation[] = [];
  const unresolved: number[] = [];
  const seen = new Set<number>();

  for (const match of answer.matchAll(CITATION)) {
    const ordinal = Number.parseInt(match[1]!, 10);

    if (seen.has(ordinal)) continue;
    seen.add(ordinal);

    const item = byOrdinal.get(ordinal);

    if (!item) {
      unresolved.push(ordinal);
      continue;
    }

    citations.push({
      ordinal: item.ordinal,
      chunkId: item.chunkId,
      documentId: item.documentId,
      documentTitle: item.documentTitle,
      pageNumber: item.pageNumber,
    });
  }

  return { citations, unresolved, ungrounded: citations.length === 0 };
}
