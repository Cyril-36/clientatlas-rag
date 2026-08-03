import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import process from "node:process";

import { DOCUMENTS_BUCKET } from "./paths";

/**
 * Storage clients.
 *
 * The important detail is which key is used. The anon key plus the caller's own
 * access token means every Storage request is evaluated by the policies on
 * `storage.objects` as that user — the same membership rules that guard row
 * access, applied to objects.
 *
 * A service-role client would bypass all of it. There is deliberately no
 * factory for one in this module: the request path has no legitimate use for
 * that key, and the easiest way to guarantee it is never reached for is to not
 * provide it here.
 */

/** Signed URLs are capabilities. They should outlive the click, and not much more. */
export const SIGNED_URL_TTL_SECONDS = 300;

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set.`);
  }

  return value;
}

/**
 * A Storage client acting as one specific user.
 *
 * The token is attached as an Authorization header rather than through a
 * session, so nothing is persisted and two concurrent requests cannot end up
 * sharing an identity.
 */
export function createUserStorageClient(accessToken: string): SupabaseClient {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    },
  );
}

export function documentsBucket(client: SupabaseClient) {
  return client.storage.from(DOCUMENTS_BUCKET);
}
