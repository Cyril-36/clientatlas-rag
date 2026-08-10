/**
 * A landing page, and a door to /workspace, which is where the product is.
 *
 * What it must not do is describe a state the application is not in. One
 * version claimed no tenant routes existed while upload, retrieval and
 * answering had all shipped; a later one said there was no browser interface
 * after one had been built. Both were worse than being plain.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">ClientAtlas</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Multi-tenant, evidence-grounded document Q&amp;A.
        </p>
      </div>

      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        Upload, ingestion, hybrid retrieval and grounded answering are implemented and reachable
        over the API with a Supabase access token. Answers are withheld unless every citation
        resolves to a passage actually retrieved from the caller&rsquo;s own workspace.
      </p>

      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        The workspace is a minimal, deliberate slice: sign in, pick a workspace, upload, ask, and
        read a cited answer. Sessions are held in cookies the page cannot read. See the{" "}
        <a
          className="underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
          href="https://github.com/Cyril-36/clientatlas-rag"
        >
          README
        </a>{" "}
        for what exists and how to run it.
      </p>

      <div className="flex gap-3">
        <a
          href="/workspace"
          className="w-fit rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white transition-colors dark:bg-zinc-100 dark:text-zinc-900"
        >
          Open the workspace
        </a>
        <a
          href="/api/health/ready"
          className="w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Readiness check
        </a>
      </div>
    </main>
  );
}
