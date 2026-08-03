import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUserStorageClient, documentsBucket } from "@/lib/storage/client";
import { buildDocumentObjectPath } from "@/lib/storage/paths";

import { getRuntimeSql } from "@/lib/database/client";

import { createTenant, truncateTenantTables, type Tenant } from "./helpers/fixtures";

/**
 * Object-level tenant isolation, against the real Supabase Storage service.
 *
 * These exercise the policies on `storage.objects`, which recover the owning
 * organisation from the object path via `app.storage_org_id` and then apply the
 * same membership helpers that guard row access. One definition of "belongs to
 * this tenant", enforced in two places.
 */

let alpha: Tenant;
let beta: Tenant;

let alphaPath: string;
let betaPath: string;

const PDF = new Uint8Array(Buffer.from("%PDF-1.7\ntest fixture\n%%EOF\n", "latin1"));

function pathFor(tenant: Tenant): string {
  return buildDocumentObjectPath({
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    documentId: randomUUID(),
    versionId: randomUUID(),
    mediaType: "application/pdf",
  });
}

beforeAll(async () => {
  await truncateTenantTables();
  alpha = await createTenant("alpha");
  beta = await createTenant("beta");

  alphaPath = pathFor(alpha);
  betaPath = pathFor(beta);

  // Seed one object per tenant, each uploaded by its own owner.
  for (const [tenant, path] of [
    [alpha, alphaPath],
    [beta, betaPath],
  ] as const) {
    const { error } = await documentsBucket(createUserStorageClient(tenant.token)).upload(
      path,
      PDF,
      { contentType: "application/pdf" },
    );

    if (error) {
      throw new Error(`fixture upload failed for ${tenant.email}: ${error.message}`);
    }
  }
});

afterAll(async () => {
  for (const [tenant, path] of [
    [alpha, alphaPath],
    [beta, betaPath],
  ] as const) {
    await documentsBucket(createUserStorageClient(tenant.token)).remove([path]);
  }

  await truncateTenantTables();
  await getRuntimeSql().end({ timeout: 5 });
});

describe("a member of the owning organisation", () => {
  it("can download its own object", async () => {
    const { data, error } = await documentsBucket(createUserStorageClient(alpha.token)).download(
      alphaPath,
    );

    expect(error).toBeNull();
    expect(await data?.text()).toContain("%PDF-1.7");
  });

  it("can create a working signed URL for its own object", async () => {
    const { data, error } = await documentsBucket(
      createUserStorageClient(alpha.token),
    ).createSignedUrl(alphaPath, 300);

    expect(error).toBeNull();
    expect(data?.signedUrl).toBeTruthy();

    const response = await fetch(data!.signedUrl);
    expect(response.status).toBe(200);
  });
});

describe("a user from another organisation", () => {
  it("cannot download the object", async () => {
    const { data, error } = await documentsBucket(createUserStorageClient(alpha.token)).download(
      betaPath,
    );

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("cannot upload into the other tenant's prefix", async () => {
    const intruder = buildDocumentObjectPath({
      organizationId: beta.organizationId,
      workspaceId: beta.workspaceId,
      documentId: randomUUID(),
      versionId: randomUUID(),
      mediaType: "application/pdf",
    });

    const { error } = await documentsBucket(createUserStorageClient(alpha.token)).upload(
      intruder,
      PDF,
      { contentType: "application/pdf" },
    );

    expect(error).not.toBeNull();
  });

  it("cannot delete the object", async () => {
    await documentsBucket(createUserStorageClient(alpha.token)).remove([betaPath]);

    // `remove` reports success for rows it simply could not see, so the only
    // trustworthy assertion is that the object is still there afterwards.
    const { data, error } = await documentsBucket(createUserStorageClient(beta.token)).download(
      betaPath,
    );

    expect(error).toBeNull();
    expect(await data?.text()).toContain("%PDF-1.7");
  });

  it("cannot discover the object by listing the prefix", async () => {
    const { data } = await documentsBucket(createUserStorageClient(alpha.token)).list(
      `organizations/${beta.organizationId}/workspaces/${beta.workspaceId}`,
    );

    expect(data ?? []).toEqual([]);
  });

  it("cannot mint a signed URL for it", async () => {
    const { data, error } = await documentsBucket(
      createUserStorageClient(alpha.token),
    ).createSignedUrl(betaPath, 300);

    expect(data?.signedUrl ?? null).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe("object immutability", () => {
  it("refuses to overwrite an existing object", async () => {
    // There is no UPDATE policy, by design: a citation must always point at the
    // bytes it was generated from. A new upload becomes a new version at a new
    // path instead.
    const { error } = await documentsBucket(createUserStorageClient(alpha.token)).update(
      alphaPath,
      new Uint8Array(Buffer.from("%PDF-1.7\nreplaced\n%%EOF\n", "latin1")),
      { contentType: "application/pdf" },
    );

    expect(error).not.toBeNull();

    const { data } = await documentsBucket(createUserStorageClient(alpha.token)).download(
      alphaPath,
    );

    expect(await data?.text()).toContain("test fixture");
  });
});

describe("path handling", () => {
  it("rejects an object path outside the tenant layout", async () => {
    // app.storage_org_id returns NULL for anything off-format, and a policy
    // comparing against NULL is false — so this is denied rather than erroring.
    const { error } = await documentsBucket(createUserStorageClient(alpha.token)).upload(
      "loose-object.pdf",
      PDF,
      { contentType: "application/pdf" },
    );

    expect(error).not.toBeNull();
  });

  it("rejects a path whose organisation segment is not a UUID", async () => {
    const { error } = await documentsBucket(createUserStorageClient(alpha.token)).upload(
      "organizations/not-a-uuid/workspaces/w/documents/d/v.pdf",
      PDF,
      { contentType: "application/pdf" },
    );

    expect(error).not.toBeNull();
  });
});

describe("signed URL expiry", () => {
  it("refuses a URL whose expiry has passed", async () => {
    const { data } = await documentsBucket(createUserStorageClient(alpha.token)).createSignedUrl(
      alphaPath,
      1,
    );

    expect(data?.signedUrl).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const response = await fetch(data!.signedUrl);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
