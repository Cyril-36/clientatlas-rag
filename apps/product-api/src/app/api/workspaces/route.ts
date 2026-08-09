import { sql } from "drizzle-orm";

import { withTenantContext } from "@/lib/database/tenant";
import { withAuthenticatedRequest } from "@/lib/http/request-context";
import { okResponse } from "@/lib/http/responses";

/**
 * The workspaces this caller can reach.
 *
 * No membership predicate in the query, deliberately. Row-level security
 * already scopes `workspaces` to the caller's organisations, and repeating the
 * rule here would suggest the database was not enforcing it — a filter that
 * looks load-bearing and is not is worse than none, because the next person
 * changes it believing it matters.
 */

export const dynamic = "force-dynamic";

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly organization_id: string;
  readonly organization_name: string;
  [key: string]: unknown;
}

export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const rows = await withTenantContext(context.claims, (tx) =>
      tx.execute<WorkspaceRow>(sql`
        select w.id, w.name, w.slug, w.organization_id, o.name as organization_name
        from workspaces w
        join organizations o on o.id = w.organization_id
        order by o.name, w.name
      `),
    );

    return okResponse(
      {
        workspaces: Array.from(rows as Iterable<WorkspaceRow>).map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          organizationId: row.organization_id,
          organizationName: row.organization_name,
        })),
      },
      context.requestId,
    );
  });
}
