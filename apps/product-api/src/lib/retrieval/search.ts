import { sql } from "drizzle-orm";

import type { TenantTransaction } from "@/lib/database/tenant";

/**
 * Hybrid retrieval.
 *
 * Two searches over the same rows — PostgreSQL full text and pgvector cosine —
 * fused by reciprocal rank fusion. They fail in different directions, which is
 * the entire reason for running both. Vector search finds a passage that means
 * the right thing while sharing no words with the query; keyword search finds
 * an exact identifier, a channel name, or a number that an embedding smooths
 * away. The measured vector-only baseline missed four questions outright at
 * top 10, and they are precisely the literal-token kind.
 *
 * Every query runs inside `withTenantContext`, so row-level security scopes it
 * before any of this is reached. Nothing here filters by organisation: doing so
 * would imply the database was not already doing it, and an `organization_id`
 * predicate that looks load-bearing but is not is worse than none at all.
 */

/** Candidates drawn from each search before fusion. */
export const DEFAULT_CANDIDATES = 20;

/** Evidence chunks handed to the generator. */
export const DEFAULT_EVIDENCE_SIZE = 8;

/**
 * The RRF constant. 60 is the value from the original paper and is deliberately
 * large relative to the candidate count: it flattens the contribution curve, so
 * fusion rewards a chunk that both searches rank *reasonably* over one that a
 * single search ranks first. A small k would let either search dominate and
 * turn the hybrid back into whichever ranked hardest.
 */
export const RRF_K = 60;

export interface RetrievedChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly ordinal: number;
  readonly content: string;
  readonly pageNumber: number | null;
  readonly headingPath: string[];
  /** Fused score. Comparable within one result set, not across queries. */
  readonly score: number;
  readonly keywordRank: number | null;
  readonly vectorRank: number | null;
}

/**
 * A raw candidate row. Snake-cased because it is what the SQL returns, and
 * carrying an index signature because Drizzle's `execute<T>` requires the row
 * type to be assignable to Record<string, unknown>.
 */
interface CandidateRow {
  [key: string]: unknown;
  chunk_id: string;
  document_id: string;
  document_title: string;
  ordinal: number;
  content: string;
  page_number: number | null;
  heading_path: string[];
}

export interface HybridSearchOptions {
  readonly workspaceId: string;
  readonly query: string;
  readonly queryEmbedding: number[];
  readonly candidates?: number;
  readonly limit?: number;
}

/**
 * `websearch_to_tsquery`, which joins terms with AND.
 *
 * It tolerates how people actually type — quoted phrases, punctuation, stray
 * operators — and cannot be made to throw by a question mark the way
 * `to_tsquery` can.
 *
 * The AND is deliberate, and was checked rather than assumed. On this corpus
 * "How do I request production access?" matches 23 chunks under AND and 1,811
 * under OR, and keyword-only recall is 0.18 flat across every k — which looks
 * like a starved arm worth widening. Widening it was measured and made the
 * hybrid clearly worse: recall@5 fell from 0.82 to 0.55, recall@10 from 0.86 to
 * 0.82, complete@10 from 0.59 to 0.55.
 *
 * The reason is how RRF weights candidates. Fusion scores by rank position
 * alone, so twenty loosely-matching OR results arrive with the same positional
 * weight as twenty precise ones and push genuine vector hits down the list. The
 * keyword arm earns its place through precision, not coverage: it contributes
 * the exact identifiers, channel names and numbers an embedding smooths away,
 * and it should stay narrow so that what it does contribute is trusted.
 */
async function keywordCandidates(
  tx: TenantTransaction,
  workspaceId: string,
  query: string,
  limit: number,
): Promise<CandidateRow[]> {
  const rows = await tx.execute<CandidateRow>(sql`
    select c.id            as chunk_id,
           c.document_id   as document_id,
           d.title         as document_title,
           c.ordinal       as ordinal,
           c.content       as content,
           c.page_number   as page_number,
           c.heading_path  as heading_path
    from document_chunks c
    join documents d on d.id = c.document_id
    where c.workspace_id = ${workspaceId}::uuid
      and d.status = 'ready'
      and c.content_tsv @@ websearch_to_tsquery('english', ${query})
    order by ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', ${query})) desc,
             c.id
    limit ${limit}
  `);

  return Array.from(rows as Iterable<CandidateRow>);
}

async function vectorCandidates(
  tx: TenantTransaction,
  workspaceId: string,
  embedding: number[],
  limit: number,
): Promise<CandidateRow[]> {
  // Serialised as a pgvector literal. The column is `vector(384)`, so a wrong
  // width is rejected by the database rather than silently compared.
  const literal = JSON.stringify(embedding);

  const rows = await tx.execute<CandidateRow>(sql`
    select c.id            as chunk_id,
           c.document_id   as document_id,
           d.title         as document_title,
           c.ordinal       as ordinal,
           c.content       as content,
           c.page_number   as page_number,
           c.heading_path  as heading_path
    from document_chunks c
    join documents d on d.id = c.document_id
    where c.workspace_id = ${workspaceId}::uuid
      and d.status = 'ready'
      and c.embedding is not null
    order by c.embedding <=> ${literal}::vector,
             c.id
    limit ${limit}
  `);

  return Array.from(rows as Iterable<CandidateRow>);
}

/**
 * Reciprocal rank fusion.
 *
 * Ranks rather than scores, on purpose. A cosine distance and a `ts_rank_cd`
 * value are not on the same scale and have no meaningful conversion between
 * them; normalising one into the other invents a relationship that does not
 * exist. Rank position is the only thing both searches genuinely agree on.
 */
export function fuse(
  lists: readonly (readonly CandidateRow[])[],
  k: number = RRF_K,
): Map<string, { row: CandidateRow; score: number; ranks: (number | null)[] }> {
  const fused = new Map<string, { row: CandidateRow; score: number; ranks: (number | null)[] }>();

  lists.forEach((list, listIndex) => {
    list.forEach((row, position) => {
      const rank = position + 1;
      const existing = fused.get(row.chunk_id);

      if (existing) {
        existing.score += 1 / (k + rank);
        existing.ranks[listIndex] = rank;
        return;
      }

      const ranks: (number | null)[] = lists.map(() => null);
      ranks[listIndex] = rank;
      fused.set(row.chunk_id, { row, score: 1 / (k + rank), ranks });
    });
  });

  return fused;
}

export async function hybridSearch(
  tx: TenantTransaction,
  options: HybridSearchOptions,
): Promise<RetrievedChunk[]> {
  const candidates = options.candidates ?? DEFAULT_CANDIDATES;
  const limit = options.limit ?? DEFAULT_EVIDENCE_SIZE;

  const [keyword, vector] = await Promise.all([
    keywordCandidates(tx, options.workspaceId, options.query, candidates),
    vectorCandidates(tx, options.workspaceId, options.queryEmbedding, candidates),
  ]);

  const fused = fuse([keyword, vector]);

  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score || a.row.chunk_id.localeCompare(b.row.chunk_id))
    .slice(0, limit)
    .map(({ row, score, ranks }) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      ordinal: row.ordinal,
      content: row.content,
      pageNumber: row.page_number,
      headingPath: row.heading_path ?? [],
      score,
      keywordRank: ranks[0] ?? null,
      vectorRank: ranks[1] ?? null,
    }));
}
