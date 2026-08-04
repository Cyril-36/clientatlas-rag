import { createClient } from "@supabase/supabase-js";

import type { AiClient, EmbedResult, ParseResult, StorageClient } from "./process-job";

/** Real implementations of the two dependencies `processJob` needs. */

export function createAiClient(baseUrl: string): AiClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // The body may carry a stable code, but nothing from it is surfaced to a
      // user from here — processJob converts every failure into its own code.
      throw new Error(`AI service returned ${response.status} for ${path}`);
    }

    return (await response.json()) as T;
  }

  return {
    async parse({ filename, mediaType, bytes }): Promise<ParseResult> {
      return post<ParseResult>("/v1/parse", {
        filename,
        mediaType,
        contentBase64: Buffer.from(bytes).toString("base64"),
      });
    },

    async embed(texts: string[]): Promise<EmbedResult> {
      return post<EmbedResult>("/v1/embed", { texts });
    },
  };
}

/**
 * Storage access for the worker.
 *
 * This is the one place the service-role key is legitimately used. The storage
 * policies are written `TO authenticated`, and a background job has no user and
 * no token — there is nobody whose membership could be checked. The worker is
 * trusted to read any object, which is exactly why it does nothing else: it
 * downloads bytes for a job it already claimed, and never serves a request.
 */
export function createStorageClient(
  supabaseUrl: string,
  serviceRoleKey: string,
  bucket: string,
): StorageClient {
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async download(path: string): Promise<Uint8Array> {
      const { data, error } = await client.storage.from(bucket).download(path);

      if (error || !data) {
        throw new Error(`storage download failed for ${path}`);
      }

      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
