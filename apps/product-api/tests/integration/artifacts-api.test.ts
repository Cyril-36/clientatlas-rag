import { randomUUID } from "node:crypto";
import process from "node:process";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as readArtifactRoute } from "@/app/api/artifacts/[artifactId]/route";
import { GET as listArtifacts } from "@/app/api/workspaces/[workspaceId]/artifacts/route";
import { readArtifact } from "@/lib/artifacts/service";
import { getRuntimeSql } from "@/lib/database/client";

import { createTenant, truncateTenantTables, type Tenant } from "./helpers/fixtures";

/**
 * Stored artifacts, under row-level security.
 *
 * Generation itself is not exercised here — it needs the model service, and
 * the browser suite covers the whole path end to end. What this file is for is
 * everything that happens to an artifact *after* it exists: whether another
 * tenant can read it, and whether a citation survives the corpus being rebuilt
 * underneath it.
 */

let alpha: Tenant;
let beta: Tenant;
let alphaArtifactId: string;
let alphaVersionId: string;
let alphaChunkId: string;

function testSql() {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  return postgres(url, { max: 1, onnotice: () => {} });
}

/** An artifact with one section and one piece of evidence, written directly. */
async function seedArtifact(tenant: Tenant): Promise<void> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const artifactId = randomUUID();
  const artifactVersionId = randomUUID();
  const sql = testSql();

  const embedding = JSON.stringify(Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));

  try {
    await sql.begin(async (tx) => {
      await tx`insert into documents
                 (id, organization_id, workspace_id, title, original_filename, media_type, status)
               values (${documentId}, ${tenant.organizationId}, ${tenant.workspaceId},
                       'Expenses handbook', 'expenses.pdf', 'application/pdf', 'ready')`;
      await tx`insert into document_versions
                 (id, organization_id, document_id, version_number, storage_path, byte_size,
                  checksum_sha256)
               values (${versionId}, ${tenant.organizationId}, ${documentId}, 1, 'x', 1,
                       ${"0".repeat(64)})`;
      await tx`insert into document_chunks
                 (id, organization_id, workspace_id, document_id, document_version_id, ordinal,
                  content, page_number, heading_path, token_count, embedding)
               values (${chunkId}, ${tenant.organizationId}, ${tenant.workspaceId}, ${documentId},
                       ${versionId}, 1, 'Claims are filed within 30 days.', 4, ${["Expenses"]}, 6,
                       ${embedding}::vector)`;

      await tx`insert into artifacts
                 (id, organization_id, workspace_id, kind, title, current_version_id)
               values (${artifactId}, ${tenant.organizationId}, ${tenant.workspaceId},
                       'readiness_report', 'Readiness report', null)`;
      await tx`insert into artifact_versions
                 (id, organization_id, artifact_id, version_number, sections, generated)
               values (${artifactVersionId}, ${tenant.organizationId}, ${artifactId}, 1,
                       ${JSON.stringify({
                         sections: [
                           {
                             key: "summary",
                             heading: "Summary",
                             body: "1 of 1",
                             coverage: "covered",
                           },
                           {
                             key: "expenses",
                             heading: "Expenses",
                             body: "Claims are filed within 30 days [1].",
                             coverage: "covered",
                           },
                         ],
                       })}::jsonb, true)`;
      await tx`insert into artifact_evidence
                 (organization_id, artifact_version_id, section_key, ordinal, chunk_id,
                  document_id, document_title, page_number, quote)
               values (${tenant.organizationId}, ${artifactVersionId}, 'expenses', 1, ${chunkId},
                       ${documentId}, 'Expenses handbook', 4,
                       'Claims are filed within 30 days [1].')`;
      await tx`update artifacts set current_version_id = ${artifactVersionId}
               where id = ${artifactId}`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  alphaArtifactId = artifactId;
  alphaVersionId = artifactVersionId;
  alphaChunkId = chunkId;
}

beforeAll(async () => {
  await truncateTenantTables();
  alpha = await createTenant("artifacts-alpha");
  beta = await createTenant("artifacts-beta");
  await seedArtifact(alpha);
});

afterAll(async () => {
  await truncateTenantTables();
  await getRuntimeSql().end({ timeout: 5 });
});

const listRequest = (token: string) =>
  new Request("http://localhost/api/workspaces/x/artifacts", {
    headers: { authorization: `Bearer ${token}` },
  });

const readRequest = (token: string) =>
  new Request("http://localhost/api/artifacts/x", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("artifacts under row-level security", () => {
  it("lists the caller's own artifact", async () => {
    const response = await listArtifacts(listRequest(alpha.token), {
      params: Promise.resolve({ workspaceId: alpha.workspaceId }),
    });

    const body = (await response.json()) as { artifacts: { id: string; versionNumber: number }[] };

    expect(response.status).toBe(200);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({ id: alphaArtifactId, versionNumber: 1 });
  });

  it("does not list another tenant's artifact", async () => {
    const response = await listArtifacts(listRequest(beta.token), {
      params: Promise.resolve({ workspaceId: alpha.workspaceId }),
    });

    expect(await response.json()).toEqual({ artifacts: [] });
  });

  it("does not let another tenant read the artifact by id", async () => {
    // The id is not a secret — it appears in a URL. The guarantee has to hold
    // when it is supplied directly.
    const response = await readArtifactRoute(readRequest(beta.token), {
      params: Promise.resolve({ artifactId: alphaArtifactId }),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("30 days");
  });

  it("returns the artifact with its evidence to its owner", async () => {
    const response = await readArtifactRoute(readRequest(alpha.token), {
      params: Promise.resolve({ artifactId: alphaArtifactId }),
    });

    const body = (await response.json()) as {
      artifact: {
        sections: { key: string }[];
        evidence: { sectionKey: string; documentTitle: string; resolves: boolean }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.artifact.sections.map((s) => s.key)).toEqual(["summary", "expenses"]);
    expect(body.artifact.evidence).toHaveLength(1);
    expect(body.artifact.evidence[0]).toMatchObject({
      sectionKey: "expenses",
      documentTitle: "Expenses handbook",
      resolves: true,
    });
  });
});

describe("evidence outliving the corpus", () => {
  it("keeps a citation, and marks it unresolved, after a re-index removes the chunk", async () => {
    // The reason artifact_evidence does not cascade from document_chunks.
    // Re-indexing replaces every chunk of a document; if the evidence went with
    // them, a stored report would quietly end up with fewer sources than it was
    // written with, and nobody would be told.
    const sql = testSql();

    try {
      await sql`delete from document_chunks where id = ${alphaChunkId}`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const artifact = await readArtifact(alpha.claims, alphaArtifactId);

    expect(artifact?.evidence).toHaveLength(1);
    expect(artifact?.evidence[0]).toMatchObject({
      resolves: false,
      documentTitle: "Expenses handbook",
      pageNumber: 4,
    });

    // The snapshotted quote is what makes the dangling citation still readable
    // rather than a reference to nothing.
    expect(artifact?.evidence[0]?.quote).toContain("30 days");
  });

  it("still returns the version itself", async () => {
    // A report whose evidence has aged is degraded, not destroyed. Refusing to
    // show it would lose the section text too.
    const artifact = await readArtifact(alpha.claims, alphaArtifactId);

    expect(artifact?.versionNumber).toBe(1);
    expect(artifact?.sections).toHaveLength(2);
  });
});

describe("versions are immutable", () => {
  it("refuses an UPDATE from the request-facing role", async () => {
    // Backed by the absence of an UPDATE grant, so this fails on privileges
    // before a policy is consulted. An editable version would make every
    // citation a claim about text that may since have changed.
    await expect(
      getRuntimeSql()`update artifact_versions set sections = '{}'::jsonb
                      where id = ${alphaVersionId}`,
    ).rejects.toThrow();
  });
});
