import { sql } from "drizzle-orm";

import { generateReadinessReport, WorkspaceNotFoundError } from "@/lib/artifacts/service";
import { withTenantContext } from "@/lib/database/tenant";
import { GenerationServiceError } from "@/lib/generation/client";
import { withAuthenticatedRequest } from "@/lib/http/request-context";
import { errorResponse, okResponse } from "@/lib/http/responses";

/**
 * Artifacts in a workspace: list them, or generate one.
 *
 * `POST` is deliberately not streamed. An answer streams because a person is
 * waiting on one paragraph; a readiness report is six probes and is read once
 * it exists, so the useful thing to return is the finished, stored version
 * rather than a progress feed nobody watches.
 */

interface RouteParams {
  readonly params: Promise<{ workspaceId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

interface ArtifactRow {
  [key: string]: unknown;
  id: string;
  kind: string;
  title: string;
  version_number: number | null;
  updated_at: string;
}

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { workspaceId } = await params;

    if (!UUID_PATTERN.test(workspaceId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid workspace id.", context.requestId);
    }

    // No membership predicate: row-level security scopes both tables, and a
    // filter that looks load-bearing and is not is worse than none.
    const rows = await withTenantContext(context.claims, (tx) =>
      tx.execute<ArtifactRow>(sql`
        select a.id, a.kind, a.title, v.version_number, a.updated_at
        from artifacts a
        left join artifact_versions v on v.id = a.current_version_id
        where a.workspace_id = ${workspaceId}::uuid
        order by a.updated_at desc
      `),
    );

    return okResponse(
      {
        artifacts: Array.from(rows as Iterable<ArtifactRow>).map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          versionNumber: row.version_number === null ? null : Number(row.version_number),
          updatedAt: String(row.updated_at),
        })),
      },
      context.requestId,
    );
  });
}

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { workspaceId } = await params;

    if (!UUID_PATTERN.test(workspaceId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid workspace id.", context.requestId);
    }

    try {
      const generated = await generateReadinessReport(context.claims, workspaceId, {
        signal: request.signal,
      });

      return okResponse(
        {
          artifactId: generated.artifactId,
          versionNumber: generated.versionNumber,
          totals: generated.totals,
          sections: generated.sections,
        },
        context.requestId,
        201,
      );
    } catch (error) {
      // A workspace the caller cannot see is not found, rather than forbidden:
      // "forbidden" would confirm the id names something real.
      if (error instanceof WorkspaceNotFoundError) {
        return errorResponse("NOT_FOUND", "No such workspace.", context.requestId);
      }

      if (error instanceof GenerationServiceError) {
        return errorResponse("PROVIDER_UNAVAILABLE", error.message, context.requestId);
      }

      throw error;
    }
  });
}
