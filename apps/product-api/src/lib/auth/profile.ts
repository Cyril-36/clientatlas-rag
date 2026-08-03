import * as schema from "@clientatlas/database/schema";

import type { TenantTransaction } from "@/lib/database/tenant";

import type { VerifiedClaims } from "./claims";

/**
 * Creates the caller's profile row if it does not exist yet.
 *
 * Supabase deployments usually do this with a trigger on `auth.users`. That
 * would need a SECURITY DEFINER function owned by a role holding BYPASSRLS,
 * because `profiles` is FORCE-protected and there are no JWT claims during
 * signup — which would mean widening the one capability boundary this project
 * keeps deliberately narrow, for a row the application can just as easily
 * create on first authenticated use.
 *
 * Here there *are* claims, so `profiles_insert_own` permits exactly this row
 * and nothing else: the policy requires `id = app.current_user_id()`, so a
 * caller cannot create a profile for anyone but themselves.
 *
 * Idempotent, and safe to call on every request.
 */
export async function ensureProfile(tx: TenantTransaction, claims: VerifiedClaims): Promise<void> {
  await tx
    .insert(schema.profiles)
    .values({ id: claims.sub, email: claims.email })
    .onConflictDoNothing({ target: schema.profiles.id });
}
