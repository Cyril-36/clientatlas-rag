import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DELETE as deleteDocument,
  GET as getDocument,
} from "@/app/api/documents/[documentId]/route";
import {
  GET as listDocuments,
  POST as uploadDocument,
} from "@/app/api/workspaces/[workspaceId]/documents/route";
import { getRuntimeSql } from "@/lib/database/client";
import { resetServerEnvForTests } from "@/lib/env";

import { createTenant, truncateTenantTables, type Tenant } from "./helpers/fixtures";
import { mintAccessToken } from "./helpers/tokens";

/**
 * The HTTP surface, driven through the real route handlers.
 *
 * These are the tests that prove the security work is actually reachable and
 * actually applied — everything below goes through token verification, the
 * claims helper, row-level security and the storage policies, in the same order
 * a browser request would.
 */

let alpha: Tenant;
let beta: Tenant;

const PDF_BYTES = Buffer.from("%PDF-1.7\nonboarding handbook\n%%EOF\n", "latin1");

function pdfFile(name = "handbook.pdf"): File {
  return new File([PDF_BYTES], name, { type: "application/pdf" });
}

function uploadRequest(token: string | null, file: File): Request {
  const form = new FormData();
  form.set("file", file);

  return new Request("http://localhost/api/workspaces/x/documents", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

function plainRequest(token: string | null, method: string): Request {
  return new Request("http://localhost/api/x", {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const workspaceParams = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });
const documentParams = (documentId: string) => ({ params: Promise.resolve({ documentId }) });

async function upload(tenant: Tenant, workspaceId: string, file = pdfFile()) {
  const response = await uploadDocument(
    uploadRequest(tenant.token, file),
    workspaceParams(workspaceId),
  );
  return { response, body: await response.json() };
}

beforeAll(async () => {
  await truncateTenantTables();
  alpha = await createTenant("alpha");
  beta = await createTenant("beta");
});

afterEach(() => {
  delete process.env["CLIENTATLAS_MODE"];
  resetServerEnvForTests();
});

afterAll(async () => {
  await truncateTenantTables();
  await getRuntimeSql().end({ timeout: 5 });
});

describe("authentication", () => {
  it("rejects a request with no token", async () => {
    const response = await listDocuments(
      plainRequest(null, "GET"),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHENTICATED");
  });

  it("rejects a forged token", async () => {
    const valid = await mintAccessToken({ sub: alpha.userId });
    const tampered = `${valid.slice(0, -3)}aaa`;

    const response = await listDocuments(
      plainRequest(tampered, "GET"),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a service_role token on the user request path", async () => {
    const token = await mintAccessToken({ sub: alpha.userId, role: "service_role" });

    const response = await listDocuments(
      plainRequest(token, "GET"),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.status).toBe(401);
  });

  it("does not leak the reason a token was rejected", async () => {
    const expired = await mintAccessToken({ sub: alpha.userId, expiresInSeconds: -60 });

    const body = await (
      await listDocuments(plainRequest(expired, "GET"), workspaceParams(alpha.workspaceId))
    ).json();

    expect(body.message).toBe("The access token is not valid.");
    expect(body.message).not.toMatch(/exp|signature|jwt/i);
  });

  it("attaches a request id to every response", async () => {
    const response = await listDocuments(
      plainRequest(null, "GET"),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("uploading", () => {
  it("accepts a valid PDF and creates the document", async () => {
    const { response, body } = await upload(alpha, alpha.workspaceId);

    expect(response.status).toBe(201);
    expect(body.status).toBe("queued");
    expect(body.originalFilename).toBe("handbook.pdf");
    expect(body.byteSize).toBe(PDF_BYTES.length);

    await deleteDocument(plainRequest(alpha.token, "DELETE"), documentParams(body.id));
  });

  it("rejects an executable renamed to .pdf", async () => {
    const machO = new File([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c])], "handbook.pdf", {
      type: "application/pdf",
    });

    const { response, body } = await upload(alpha, alpha.workspaceId, machO);

    expect(response.status).toBe(422);
    expect(body.code).toBe("FILE_UNREADABLE");
  });

  it("rejects an unsupported media type", async () => {
    const csv = new File([Buffer.from("a,b,c")], "sheet.csv", { type: "text/csv" });

    const { response, body } = await upload(alpha, alpha.workspaceId, csv);

    expect(response.status).toBe(415);
    expect(body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("rejects a request that is not multipart", async () => {
    const response = await uploadDocument(
      new Request("http://localhost/api/x", {
        method: "POST",
        headers: { authorization: `Bearer ${alpha.token}`, "content-type": "application/json" },
        body: JSON.stringify({ nope: true }),
      }),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.status).toBe(422);
  });

  it("rejects a malformed workspace id without touching the database", async () => {
    const response = await uploadDocument(
      uploadRequest(alpha.token, pdfFile()),
      workspaceParams("../../etc/passwd"),
    );

    expect(response.status).toBe(422);
  });
});

describe("cross-tenant access", () => {
  let betaDocumentId: string;

  beforeAll(async () => {
    const { body } = await upload(beta, beta.workspaceId);
    betaDocumentId = body.id;
  });

  it("reports another tenant's workspace as not found when uploading", async () => {
    const { response, body } = await upload(alpha, beta.workspaceId);

    // Not 403. A 403 would confirm the workspace exists.
    expect(response.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns an empty list for another tenant's workspace", async () => {
    const response = await listDocuments(
      plainRequest(alpha.token, "GET"),
      workspaceParams(beta.workspaceId),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).documents).toEqual([]);
  });

  it("refuses to issue a download URL for another tenant's document", async () => {
    const response = await getDocument(
      plainRequest(alpha.token, "GET"),
      documentParams(betaDocumentId),
    );

    expect(response.status).toBe(404);
  });

  it("refuses to delete another tenant's document, and leaves it intact", async () => {
    const response = await deleteDocument(
      plainRequest(alpha.token, "DELETE"),
      documentParams(betaDocumentId),
    );

    expect(response.status).toBe(404);

    const stillThere = await getDocument(
      plainRequest(beta.token, "GET"),
      documentParams(betaDocumentId),
    );

    expect(stillThere.status).toBe(200);
  });

  it("reports a document that does not exist at all the same way", async () => {
    const response = await getDocument(
      plainRequest(alpha.token, "GET"),
      documentParams(randomUUID()),
    );

    // Indistinguishable from "exists, but not yours" — which is the point.
    expect(response.status).toBe(404);
  });
});

describe("download and delete", () => {
  it("issues a signed URL that actually fetches the bytes", async () => {
    const { body: created } = await upload(alpha, alpha.workspaceId);

    const response = await getDocument(
      plainRequest(alpha.token, "GET"),
      documentParams(created.id),
    );
    const { url } = await response.json();

    expect(response.status).toBe(200);

    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toContain("onboarding handbook");

    await deleteDocument(plainRequest(alpha.token, "DELETE"), documentParams(created.id));
  });

  it("removes the row and the object", async () => {
    const { body: created } = await upload(alpha, alpha.workspaceId);

    const { url } = await (
      await getDocument(plainRequest(alpha.token, "GET"), documentParams(created.id))
    ).json();

    const deleted = await deleteDocument(
      plainRequest(alpha.token, "DELETE"),
      documentParams(created.id),
    );

    expect(deleted.status).toBe(200);

    // The row is gone.
    const afterwards = await getDocument(
      plainRequest(alpha.token, "GET"),
      documentParams(created.id),
    );
    expect(afterwards.status).toBe(404);

    // And so is the object: a URL signed while it existed no longer resolves.
    const fetched = await fetch(url);
    expect(fetched.status).toBeGreaterThanOrEqual(400);
  });
});

describe("demo mode", () => {
  it("refuses mutations", async () => {
    process.env["CLIENTATLAS_MODE"] = "demo";
    resetServerEnvForTests();

    const response = await uploadDocument(
      uploadRequest(alpha.token, pdfFile()),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("DEMO_READ_ONLY");
  });

  it("still allows reads", async () => {
    process.env["CLIENTATLAS_MODE"] = "demo";
    resetServerEnvForTests();

    const response = await listDocuments(
      plainRequest(alpha.token, "GET"),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.status).toBe(200);
  });

  it("refuses a mutation before checking the token", async () => {
    // Otherwise the 401/403 ordering would tell an unauthenticated prober which
    // endpoints are mutations.
    process.env["CLIENTATLAS_MODE"] = "demo";
    resetServerEnvForTests();

    const response = await uploadDocument(
      uploadRequest(null, pdfFile()),
      workspaceParams(alpha.workspaceId),
    );

    expect(response.status).toBe(403);
  });
});
