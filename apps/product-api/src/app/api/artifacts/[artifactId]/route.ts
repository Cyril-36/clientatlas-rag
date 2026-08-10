import { readArtifact } from "@/lib/artifacts/service";
import { withAuthenticatedRequest } from "@/lib/http/request-context";
import { errorResponse, okResponse } from "@/lib/http/responses";

/** One artifact's current version, with its evidence resolved. */

interface RouteParams {
  readonly params: Promise<{ artifactId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { artifactId } = await params;

    if (!UUID_PATTERN.test(artifactId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid artifact id.", context.requestId);
    }

    const artifact = await readArtifact(context.claims, artifactId);

    // Null covers both "no such artifact" and "not yours" — row-level security
    // makes them the same query result, and they should stay the same answer.
    if (!artifact) {
      return errorResponse("NOT_FOUND", "No such artifact.", context.requestId);
    }

    return okResponse({ artifact }, context.requestId);
  });
}
