import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@clientatlas/contracts";
import { completeJob, failJob, heartbeat, type ClaimedJob } from "@clientatlas/database/queue";
import type postgres from "postgres";

/**
 * Processing one ingestion job.
 *
 * Dependencies are injected rather than constructed here, so this can be tested
 * for its ordering and failure behaviour without a model, a storage service or
 * a network. What it gets wrong under failure matters more than what it does
 * when everything works, and the failure paths are the hard ones to reach by
 * hand.
 */

export interface ParsedChunk {
  readonly ordinal: number;
  readonly text: string;
  readonly pageNumber: number | null;
  readonly headingPath: string[];
  readonly tokenCount: number;
}

export interface ParseResult {
  readonly chunks: ParsedChunk[];
  readonly pageCount: number;
  readonly checksumSha256: string;
}

export interface EmbedResult {
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: number[][];
}

export interface AiClient {
  parse(input: { filename: string; mediaType: string; bytes: Uint8Array }): Promise<ParseResult>;
  embed(texts: string[]): Promise<EmbedResult>;
}

export interface StorageClient {
  download(path: string): Promise<Uint8Array>;
}

export interface ProcessDependencies {
  readonly sql: postgres.Sql;
  readonly ai: AiClient;
  readonly storage: StorageClient;
  readonly workerId: string;
}

/** Stable codes. Never a parser or driver message, which can quote the document. */
export type IngestionFailureCode =
  | "VERSION_NOT_FOUND"
  | "DOWNLOAD_FAILED"
  | "PARSE_FAILED"
  | "EMBEDDING_FAILED"
  | "EMBEDDING_MODEL_MISMATCH"
  | "NO_CONTENT"
  | "WRITE_FAILED";

export class IngestionError extends Error {
  constructor(readonly code: IngestionFailureCode) {
    super(code);
    this.name = "IngestionError";
  }
}

/** Matches the AI service's own batch ceiling. */
const EMBED_BATCH_SIZE = 64;

export async function processJob(
  deps: ProcessDependencies,
  job: ClaimedJob,
): Promise<"succeeded" | "retry_scheduled" | "gave_up"> {
  const { sql, ai, storage, workerId } = deps;

  try {
    const [version] = await sql<
      { storage_path: string; workspace_id: string; media_type: string; filename: string }[]
    >`
      select v.storage_path, d.workspace_id, d.media_type, d.original_filename as filename
      from document_versions v
      join documents d on d.id = v.document_id
      where v.id = ${job.documentVersionId}
    `;

    if (!version) {
      throw new IngestionError("VERSION_NOT_FOUND");
    }

    await sql`
      update documents set status = 'processing', updated_at = now()
      where id = ${job.documentId}
    `;

    let bytes: Uint8Array;
    try {
      bytes = await storage.download(version.storage_path);
    } catch {
      throw new IngestionError("DOWNLOAD_FAILED");
    }

    let parsed: ParseResult;
    try {
      parsed = await ai.parse({
        filename: version.filename,
        mediaType: version.media_type,
        bytes,
      });
    } catch {
      throw new IngestionError("PARSE_FAILED");
    }

    if (parsed.chunks.length === 0) {
      throw new IngestionError("NO_CONTENT");
    }

    // Parsing a large document takes a while. Without this the reclaim sweep
    // would decide the worker had died and hand the job to someone else, and
    // two workers would write chunks for the same version.
    await heartbeat(sql, job.id, workerId);

    const vectors: number[][] = [];

    for (let offset = 0; offset < parsed.chunks.length; offset += EMBED_BATCH_SIZE) {
      const batch = parsed.chunks.slice(offset, offset + EMBED_BATCH_SIZE);

      let result: EmbedResult;
      try {
        result = await ai.embed(batch.map((chunk) => chunk.text));
      } catch {
        throw new IngestionError("EMBEDDING_FAILED");
      }

      // The deterministic provider used in tests and CI reports its own name,
      // so this is what stops meaningless vectors reaching the database and
      // silently poisoning retrieval. A mismatch is a configuration error, not
      // a transient one — but it is still retried, because the fix is to point
      // the service at the real model and the job should then succeed.
      if (result.model !== EMBEDDING_MODEL || result.dimensions !== EMBEDDING_DIMENSIONS) {
        throw new IngestionError("EMBEDDING_MODEL_MISMATCH");
      }

      vectors.push(...result.vectors);
      await heartbeat(sql, job.id, workerId);
    }

    if (vectors.length !== parsed.chunks.length) {
      throw new IngestionError("EMBEDDING_FAILED");
    }

    try {
      await sql.begin(async (tx) => {
        // Re-indexing replaces rather than accumulates. Without this a second
        // run would double every chunk and retrieval would return each passage
        // twice.
        await tx`delete from document_chunks where document_version_id = ${job.documentVersionId}`;

        for (const [index, chunk] of parsed.chunks.entries()) {
          await tx`
            insert into document_chunks
              (organization_id, workspace_id, document_id, document_version_id,
               ordinal, content, page_number, heading_path, token_count, embedding)
            values
              (${job.organizationId}, ${version.workspace_id}, ${job.documentId},
               ${job.documentVersionId}, ${chunk.ordinal}, ${chunk.text},
               ${chunk.pageNumber}, ${chunk.headingPath}, ${chunk.tokenCount},
               ${JSON.stringify(vectors[index])}::vector)
          `;
        }

        await tx`
          update document_versions set page_count = ${parsed.pageCount}
          where id = ${job.documentVersionId}
        `;

        await tx`
          update documents
          set status = 'ready', failure_code = null, updated_at = now()
          where id = ${job.documentId}
        `;
      });
    } catch {
      throw new IngestionError("WRITE_FAILED");
    }

    await completeJob(sql, job.id);
    return "succeeded";
  } catch (error: unknown) {
    const code = error instanceof IngestionError ? error.code : "WRITE_FAILED";
    const outcome = await failJob(sql, job.id, code);

    // Only a terminal failure marks the document failed. While retries remain
    // the document stays `processing`, because it may still succeed and showing
    // a user "failed" on an attempt that later works is worse than showing
    // nothing.
    if (outcome === "gave_up") {
      await sql`
        update documents
        set status = 'failed', failure_code = ${code}, updated_at = now()
        where id = ${job.documentId}
      `;
    }

    return outcome;
  }
}
