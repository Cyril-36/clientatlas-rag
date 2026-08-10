import { sql } from "drizzle-orm";

import type { VerifiedClaims } from "@/lib/auth/claims";
import {
  DEFAULT_DIMENSIONS,
  resultFor,
  score,
  toSections,
  type DimensionResult,
  type ReadinessDimension,
  type ReadinessScore,
  type ReadinessSection,
} from "@/lib/artifacts/readiness";
import { withTenantContext } from "@/lib/database/tenant";
import { answer, type AnswerEvent } from "@/lib/generation/answer";
import { embedQuestion } from "@/lib/generation/client";

/**
 * Generating a readiness report, and storing it so it stays checkable.
 *
 * Each dimension is one ordinary question through the ordinary answer path.
 * That is the design, not a shortcut: a report that used a private, laxer
 * retrieval or a private, laxer citation rule would be making claims the
 * product would refuse to make if a person asked the same question out loud.
 */

export interface GeneratedArtifact {
  readonly artifactId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly sections: readonly ReadinessSection[];
  readonly totals: ReadinessScore;
}

interface Row {
  [key: string]: unknown;
}

/**
 * Ask one probe and collect the whole stream.
 *
 * Sequential across dimensions rather than parallel. Six concurrent
 * generations against one local model is slower in wall-clock than six in a
 * row and far more likely to time out, and the failure mode — several
 * dimensions marked `unavailable` because the model service was saturated by
 * this very request — would be a report describing its own load.
 */
async function assess(
  claims: VerifiedClaims,
  workspaceId: string,
  dimension: ReadinessDimension,
  signal?: AbortSignal,
): Promise<DimensionResult> {
  const events: AnswerEvent[] = [];

  try {
    const embedding = await embedQuestion(dimension.probe, signal);

    for await (const event of answer(claims, {
      workspaceId,
      question: dimension.probe,
      questionEmbedding: embedding,
      ...(signal ? { signal } : {}),
    })) {
      events.push(event);
    }
  } catch (error) {
    // Recorded as an unassessable dimension rather than failing the whole
    // report. One unreachable probe should not discard five good ones, and the
    // score keeps `unavailable` out of both counts precisely so this stays
    // visible instead of masquerading as a gap.
    events.push({
      type: "error",
      code: "generation_unavailable",
      message: error instanceof Error ? error.message : "the probe could not be run",
    });
  }

  return resultFor(dimension, events);
}

/**
 * Generate a readiness report and store it as a new version.
 *
 * Writing is one transaction. A version without its evidence would be a report
 * whose citations silently vanished, which is worse than no report — so either
 * the artifact, the version and every evidence row land together, or none do.
 */
export async function generateReadinessReport(
  claims: VerifiedClaims,
  workspaceId: string,
  options: { dimensions?: readonly ReadinessDimension[]; signal?: AbortSignal } = {},
): Promise<GeneratedArtifact> {
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;

  const results: DimensionResult[] = [];

  for (const dimension of dimensions) {
    results.push(await assess(claims, workspaceId, dimension, options.signal));
  }

  const totals = score(results);
  const sections = toSections(results, totals);

  return withTenantContext(claims, async (tx) => {
    // One artifact per workspace per kind. Regenerating appends a version
    // rather than creating a second report, so the history of "what did we know
    // in March" stays in one place and a citation from an old version still
    // resolves.
    const existing = Array.from(
      (await tx.execute<Row>(sql`
        select id, organization_id from artifacts
        where workspace_id = ${workspaceId}::uuid and kind = 'readiness_report'
        limit 1
      `)) as Iterable<Row>,
    )[0];

    let artifactId = existing?.["id"] as string | undefined;
    let organizationId = existing?.["organization_id"] as string | undefined;

    if (!artifactId) {
      // The organisation is read from the workspace rather than taken from the
      // caller: row-level security has already decided which workspaces are
      // visible, and deriving the tenant from the row keeps the two from
      // disagreeing.
      const workspace = Array.from(
        (await tx.execute<Row>(sql`
          select organization_id from workspaces where id = ${workspaceId}::uuid
        `)) as Iterable<Row>,
      )[0];

      if (!workspace) {
        throw new WorkspaceNotFoundError(workspaceId);
      }

      organizationId = workspace["organization_id"] as string;

      const inserted = Array.from(
        (await tx.execute<Row>(sql`
          insert into artifacts (organization_id, workspace_id, kind, title)
          values (${organizationId}::uuid, ${workspaceId}::uuid, 'readiness_report',
                  'Readiness report')
          returning id
        `)) as Iterable<Row>,
      )[0];

      artifactId = inserted!["id"] as string;
    }

    const next = Array.from(
      (await tx.execute<Row>(sql`
        select coalesce(max(version_number), 0) + 1 as number
        from artifact_versions where artifact_id = ${artifactId}::uuid
      `)) as Iterable<Row>,
    )[0];

    const versionNumber = Number(next!["number"]);

    const version = Array.from(
      (await tx.execute<Row>(sql`
        insert into artifact_versions
          (organization_id, artifact_id, version_number, sections, authored_by, generated)
        values (${organizationId}::uuid, ${artifactId}::uuid, ${versionNumber},
                ${JSON.stringify({ sections })}::jsonb, ${claims.sub}::uuid, true)
        returning id
      `)) as Iterable<Row>,
    )[0];

    const versionId = version!["id"] as string;

    for (const result of results) {
      for (const citation of result.citations) {
        await tx.execute(sql`
          insert into artifact_evidence
            (organization_id, artifact_version_id, section_key, ordinal, chunk_id, document_id,
             document_title, page_number, quote)
          values (${organizationId}::uuid, ${versionId}::uuid, ${result.key}, ${citation.ordinal},
                  ${citation.chunkId}::uuid, ${citation.documentId}::uuid,
                  ${citation.documentTitle}, ${citation.pageNumber},
                  ${quoteFor(result, citation.ordinal)})
        `);
      }
    }

    await tx.execute(sql`
      update artifacts set current_version_id = ${versionId}::uuid, updated_at = now()
      where id = ${artifactId}::uuid
    `);

    return { artifactId: artifactId!, versionId, versionNumber, sections, totals };
  });
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`No workspace ${workspaceId} is visible to this caller.`);
    this.name = "WorkspaceNotFoundError";
  }
}

/**
 * The sentence in the section that carries this citation.
 *
 * Stored so a citation still reads correctly when the chunk behind it is gone
 * — after a re-index, the evidence row is all that remains, and "[2] Expenses
 * handbook, page 4" with no text is a reference to nothing a reader can check.
 */
function quoteFor(result: DimensionResult, ordinal: number): string {
  const marker = `[${ordinal}]`;

  const sentence = result.summary
    .split(/(?<=[.!?])\s+/)
    .find((part) => part.includes(marker))
    ?.trim();

  return sentence && sentence.length > 0 ? sentence : result.summary.trim();
}

/**
 * Read the stored sections, whichever shape the driver hands back.
 *
 * `jsonb` arrives as a parsed object through some driver configurations and as
 * a string through others, and this code should not depend on which. It came
 * back as a string here, and the symptom was an artifact that read as having no
 * sections at all while its evidence resolved perfectly — a report with
 * citations and no text.
 */
function parseSections(value: unknown): ReadinessSection[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;

  if (!parsed || typeof parsed !== "object") return [];

  const sections = (parsed as { sections?: unknown }).sections;

  return Array.isArray(sections) ? (sections as ReadinessSection[]) : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export interface StoredArtifact {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly versionNumber: number;
  readonly sections: readonly ReadinessSection[];
  readonly evidence: readonly {
    readonly sectionKey: string;
    readonly ordinal: number;
    readonly chunkId: string;
    readonly documentId: string;
    readonly documentTitle: string;
    readonly pageNumber: number | null;
    readonly quote: string;
    /** False when the passage no longer exists — a re-index replaced it. */
    readonly resolves: boolean;
  }[];
  readonly updatedAt: string;
}

/** Read an artifact's current version, with its evidence resolved. */
export async function readArtifact(
  claims: VerifiedClaims,
  artifactId: string,
): Promise<StoredArtifact | null> {
  return withTenantContext(claims, async (tx) => {
    const rows = Array.from(
      (await tx.execute<Row>(sql`
        select a.id, a.kind, a.title, a.updated_at, v.id as version_id,
               v.version_number, v.sections
        from artifacts a
        join artifact_versions v on v.id = a.current_version_id
        where a.id = ${artifactId}::uuid
      `)) as Iterable<Row>,
    );

    const artifact = rows[0];
    if (!artifact) return null;

    // `resolves` is computed by looking, not assumed. An evidence row whose
    // chunk was replaced by a re-index is still shown — with its snapshotted
    // quote and a flag — because silently dropping it would make the report
    // appear to have had fewer sources than it did.
    const evidence = Array.from(
      (await tx.execute<Row>(sql`
        select e.section_key, e.ordinal, e.chunk_id, e.document_id, e.document_title,
               e.page_number, e.quote, (c.id is not null) as resolves
        from artifact_evidence e
        left join document_chunks c on c.id = e.chunk_id
        where e.artifact_version_id = ${artifact["version_id"]}::uuid
        order by e.section_key, e.ordinal
      `)) as Iterable<Row>,
    );

    const stored = parseSections(artifact["sections"]);

    return {
      id: artifact["id"] as string,
      kind: artifact["kind"] as string,
      title: artifact["title"] as string,
      versionNumber: Number(artifact["version_number"]),
      sections: stored,
      evidence: evidence.map((row) => ({
        sectionKey: row["section_key"] as string,
        ordinal: Number(row["ordinal"]),
        chunkId: row["chunk_id"] as string,
        documentId: row["document_id"] as string,
        documentTitle: row["document_title"] as string,
        pageNumber: row["page_number"] === null ? null : Number(row["page_number"]),
        quote: row["quote"] as string,
        resolves: row["resolves"] === true,
      })),
      updatedAt: String(artifact["updated_at"]),
    };
  });
}
