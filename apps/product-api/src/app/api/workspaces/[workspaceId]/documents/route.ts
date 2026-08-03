import { createDocument, listDocuments, DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/documents/service";
import { withAuthenticatedRequest } from "@/lib/http/request-context";
import { errorResponse, okResponse } from "@/lib/http/responses";

interface RouteParams {
  readonly params: Promise<{ workspaceId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { workspaceId } = await params;

    if (!UUID_PATTERN.test(workspaceId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid workspace id.", context.requestId);
    }

    // No membership check here on purpose. Row-level security scopes the query,
    // so a workspace in another tenant simply returns nothing.
    const documents = await listDocuments(context, workspaceId);

    return okResponse({ documents }, context.requestId);
  });
}

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  return withAuthenticatedRequest(request, async (context) => {
    const { workspaceId } = await params;

    if (!UUID_PATTERN.test(workspaceId)) {
      return errorResponse("VALIDATION_FAILED", "Invalid workspace id.", context.requestId);
    }

    let form: FormData;

    try {
      form = await request.formData();
    } catch {
      return errorResponse(
        "VALIDATION_FAILED",
        "Expected a multipart form containing a file.",
        context.requestId,
      );
    }

    const file = form.get("file");

    if (!(file instanceof File)) {
      return errorResponse(
        "VALIDATION_FAILED",
        "Expected a multipart form field named 'file'.",
        context.requestId,
      );
    }

    // Checked before reading the body into memory, so an oversized upload is
    // refused rather than buffered.
    if (file.size > DEFAULT_MAX_UPLOAD_BYTES) {
      return errorResponse(
        "FILE_TOO_LARGE",
        `The file is larger than the ${Math.floor(DEFAULT_MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
        context.requestId,
      );
    }

    const result = await createDocument(context, {
      workspaceId,
      filename: file.name,
      declaredMediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });

    if (!result.ok) {
      return errorResponse(result.code, result.message, context.requestId);
    }

    return okResponse(result.value, context.requestId, 201);
  });
}
