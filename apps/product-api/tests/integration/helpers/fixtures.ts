import process from "node:process";
import { randomUUID } from "node:crypto";

import * as schema from "@clientatlas/database/schema";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import { DOCUMENTS_BUCKET } from "@/lib/storage/paths";

import type { VerifiedClaims } from "@/lib/auth/claims";
import { withTenantContext } from "@/lib/database/tenant";

import { mintAccessToken } from "./tokens";

/**
 * Two independent tenants, built the way the product builds them.
 *
 * Only the `profiles` rows are seeded with the BYPASSRLS test role, because a
 * real deployment creates those out of band from a Supabase auth trigger.
 * Everything else — the organization, the ownership record, the workspace — is
 * created as `authenticated`, through the same policies a user goes through.
 *
 * That matters. A fixture that seeded rows with BYPASSRLS would prove only that
 * the fixture works, and would happily set up a world the policies would never
 * have allowed.
 */

export interface Tenant {
  readonly userId: string;
  readonly email: string;
  readonly claims: VerifiedClaims;
  readonly token: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}

function testSql(): ReturnType<typeof postgres> {
  const url = process.env["TEST_DATABASE_URL"];

  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need the clientatlas_test credential " +
        "to seed the profile rows Supabase would create at signup.",
    );
  }

  return postgres(url, { max: 2, onnotice: () => {} });
}

export async function createTenant(label: string): Promise<Tenant> {
  const userId = randomUUID();
  const email = `${label}-${userId.slice(0, 8)}@example.test`;
  const organizationId = randomUUID();

  const sql = testSql();

  try {
    await sql`
      insert into public.profiles (id, email, display_name)
      values (${userId}, ${email}, ${label})
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }

  const token = await mintAccessToken({ sub: userId, email });
  const claims: VerifiedClaims = { sub: userId, role: "authenticated", email };

  const workspaceId = await withTenantContext(claims, async (tx) => {
    // The id is generated here rather than by the database because the caller
    // is not a member yet, so the SELECT policy does not pass and
    // `INSERT ... RETURNING` would fail. Both statements are in one
    // transaction, so an organization can never exist without its owner.
    await tx.insert(schema.organizations).values({
      id: organizationId,
      name: `${label} organization`,
      slug: `${label}-${organizationId.slice(0, 8)}`,
    });

    await tx.insert(schema.organizationMembers).values({
      organizationId,
      userId,
      role: "owner",
    });

    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({
        organizationId,
        name: `${label} workspace`,
        slug: "onboarding",
      })
      .returning({ id: schema.workspaces.id });

    if (!workspace) {
      throw new Error("Workspace insert returned no row.");
    }

    return workspace.id;
  });

  return { userId, email, claims, token, organizationId, workspaceId };
}

/**
 * Empties the documents bucket.
 *
 * Truncating the tables does not touch object storage — the two are different
 * systems, and a cascade in one says nothing about the other. Without this,
 * every test run left objects behind that no row referenced, and the local
 * bucket filled with garbage nobody would ever look for.
 *
 * Uses the service-role key, which is legitimate here and only here: the point
 * is to clean up regardless of which tenant owned what. It is the local stack's
 * well-known demo key and reaches nothing beyond 127.0.0.1.
 */
async function purgeDocumentObjects(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

  if (!url || !serviceRoleKey) {
    return;
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // `list` is not recursive, so walk the prefixes the layout actually uses.
  const paths: string[] = [];

  const walk = async (prefix: string, depth: number): Promise<void> => {
    const { data } = await admin.storage.from(DOCUMENTS_BUCKET).list(prefix, { limit: 1000 });

    for (const entry of data ?? []) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.id === null && depth < 6) {
        await walk(next, depth + 1);
      } else if (entry.id !== null) {
        paths.push(next);
      }
    }
  };

  await walk("", 0);

  if (paths.length > 0) {
    await admin.storage.from(DOCUMENTS_BUCKET).remove(paths);
  }
}

/** Removes every row and object created by the suite. */
export async function truncateTenantTables(): Promise<void> {
  await purgeDocumentObjects();

  const sql = testSql();

  try {
    await sql`truncate table public.organizations, public.profiles restart identity cascade`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
