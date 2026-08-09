/**
 * A placeholder, and it says so.
 *
 * There is no browser interface yet: the product is an API, and the session
 * design that a sign-in form depends on is an open decision rather than an
 * unstarted task. What this page must not do is describe a state the
 * application is not in — an earlier version claimed no tenant routes existed
 * while upload, retrieval and answering had all shipped, which is a worse
 * failure than being plain.
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
        There is no browser interface yet — this page is a placeholder, not the product. See the{" "}
        <a
          className="underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
          href="https://github.com/Cyril-36/clientatlas-rag"
        >
          README
        </a>{" "}
        for what exists and how to exercise it.
      </p>

      <a
        href="/api/health/ready"
        className="w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Readiness check
      </a>
    </main>
  );
}
