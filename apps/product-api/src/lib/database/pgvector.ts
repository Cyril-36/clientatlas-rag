/**
 * The pgvector version retrieval depends on.
 *
 * `hybridSearch` sets `hnsw.iterative_scan`, which pgvector added in 0.8.
 * Below that, an HNSW scan behind a `workspace_id` predicate stops after
 * `ef_search` candidates whether or not enough of them passed the filter, so a
 * tenant holding a small share of `document_chunks` gets back a short page of
 * results and no error. Measured on the evaluation corpus, a workspace holding
 * 3.6% of the table returned a mean 0.07 of the passages an exact scan would.
 *
 * The gate that matters is a migration, which refuses to run below 0.8.0. This
 * exists for the readiness probe: a database can be restored, failed over or
 * repointed under a running deployment without migrations being re-applied,
 * and the only other symptom of that is quietly worse answers.
 */

/** Minimum supported pgvector, as [major, minor, patch]. */
export const MINIMUM_PGVECTOR = [0, 8, 0] as const;

/**
 * Is `version` at least {@link MINIMUM_PGVECTOR}?
 *
 * Compared component-wise as numbers rather than as text, because "0.10.0"
 * sorts before "0.8.0" as a string and that is the wrong way round. An absent
 * or unparseable version is treated as unsupported: this decides whether to
 * serve traffic, so the unknown case has to be the cautious one.
 */
export function isSupportedPgvector(version: string | undefined | null): boolean {
  if (!version) return false;

  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some(Number.isNaN)) return false;

  for (const [index, minimum] of MINIMUM_PGVECTOR.entries()) {
    const part = parts[index] ?? 0;
    if (part > minimum) return true;
    if (part < minimum) return false;
  }

  return true;
}
