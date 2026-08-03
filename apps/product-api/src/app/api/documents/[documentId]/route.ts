import { createDownloadUrl, deleteDocument } from "@/lib/documents/service";
import { withAuthenticatedRequest } from "@/lib/http/request-context";
import { errorResponse, okResponse } from "@/lib/http/responses";

interface RouteParams {
  readonly params: Promise<{ documentId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns a short-lived signed download URL for the latest version. */
export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { documentId } = await params;

    if (!UUID_PATTERN.test(documentId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid document id.", context.requestId);
    }

    const url = await createDownloadUrl(context, documentId);

    if (!url) {
      // Covers both "no such document" and "not yours". They must be
      // indistinguishable, or the response confirms the document exists.
      return errorResponse("NOT_FOUND", "That document does not exist.", context.requestId);
    }

    return okResponse({ url }, context.requestId);
  });
}

export async function DELETE(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { documentId } = await params;

    if (!UUID_PATTERN.test(documentId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid document id.", context.requestId);
    }

    const removed = await deleteDocument(context, documentId);

    if (!removed) {
      return errorResponse("NOT_FOUND", "That document does not exist.", context.requestId);
    }

    return okResponse({ deleted: true }, context.requestId);
  });
}
