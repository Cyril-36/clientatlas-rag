export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">ClientAtlas</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Multi-tenant onboarding and knowledge workspace.
        </p>
      </div>

      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        Milestone 1 — foundation. Authentication, tenancy and row-level security land in M2. Until
        then this application stores no tenant data and exposes no tenant routes.
      </p>

      <a
        href="/api/health"
        className="w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Health check
      </a>
    </main>
  );
}
