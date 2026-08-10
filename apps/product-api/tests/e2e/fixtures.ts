import { randomUUID } from "node:crypto";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

/**
 * Real users, real organisations, real documents.
 *
 * Everything here is created the way the application would have it: a Supabase
 * Auth user with a password that is actually used to sign in, and rows written
 * with the BYPASSRLS test credential because chunks are worker output and the
 * request-facing role correctly cannot insert them.
 *
 * No token is minted. The browser signs in and receives cookies, which is the
 * only way to exercise a design whose premise is that the page never holds the
 * credential.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; the e2e run needs the local Supabase stack`);
  return value;
}

export interface E2EUser {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

function admin() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function db() {
  return postgres(required("TEST_DATABASE_URL"), { max: 2, onnotice: () => {} });
}

export async function createUser(label: string): Promise<E2EUser> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `E2e-${randomUUID()}-aA9!`;

  const created = await admin().auth.admin.createUser({ email, password, email_confirm: true });

  if (created.error || !created.data.user) {
    throw new Error(`could not create the test user: ${created.error?.message}`);
  }

  const userId = created.data.user.id;
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const workspaceName = `${label} workspace`;
  const sql = db();

  try {
    await sql.begin(async (tx) => {
      await tx`insert into profiles (id, email, display_name)
               values (${userId}, ${email}, ${label})`;
      await tx`insert into organizations (id, name, slug)
               values (${organizationId}, ${`${label} org`}, ${`${label}-${organizationId.slice(0, 8)}`})`;
      await tx`insert into organization_members (organization_id, user_id, role)
               values (${organizationId}, ${userId}, 'owner')`;
      await tx`insert into workspaces (id, organization_id, name, slug)
               values (${workspaceId}, ${organizationId}, ${workspaceName}, ${`ws-${workspaceId.slice(0, 8)}`})`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  return { email, password, userId, organizationId, workspaceId, workspaceName };
}

/**
 * A document that is already `ready`, with one chunk and an embedding.
 *
 * Ingestion runs in a worker and takes an unbounded amount of time; the browser
 * test is about the browser, not about how long PyMuPDF takes. The upload path
 * is exercised separately in the flow test, against the real endpoint — what is
 * short-circuited here is only the wait for a background job.
 */
export async function seedReadyDocument(
  user: E2EUser,
  title: string,
  content: string,
): Promise<{ documentId: string; chunkId: string }> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const sql = db();

  // A unit vector on the first axis. Retrieval only has to find the one chunk
  // present, and a hand-written vector keeps the model out of the browser test.
  const embedding = JSON.stringify(Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));

  try {
    await sql.begin(async (tx) => {
      await tx`insert into documents
                 (id, organization_id, workspace_id, title, original_filename, media_type, status)
               values (${documentId}, ${user.organizationId}, ${user.workspaceId}, ${title},
                       ${`${title}.pdf`}, 'application/pdf', 'ready')`;
      await tx`insert into document_versions
                 (id, organization_id, document_id, version_number, storage_path, byte_size,
                  checksum_sha256)
               values (${versionId}, ${user.organizationId}, ${documentId}, 1,
                       ${`organizations/${user.organizationId}/${documentId}.pdf`}, 1,
                       ${"0".repeat(64)})`;
      await tx`insert into document_chunks
                 (id, organization_id, workspace_id, document_id, document_version_id, ordinal,
                  content, page_number, heading_path, token_count, embedding)
               values (${chunkId}, ${user.organizationId}, ${user.workspaceId}, ${documentId},
                       ${versionId}, 1, ${content}, 1, ${["Handbook"]},
                       ${content.split(/\s+/).length}, ${embedding}::vector)`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  return { documentId, chunkId };
}

export async function deleteUser(user: E2EUser): Promise<void> {
  const sql = db();

  try {
    await sql`delete from organizations where id = ${user.organizationId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await admin().auth.admin.deleteUser(user.userId);
}
