# ClientAtlas

A multi-tenant onboarding and knowledge workspace. Teams upload documents, ask
questions, and get streamed answers that are grounded in their own material —
with every claim traceable to the page it came from, or no answer at all.

Built to run end to end at zero mandatory cost, with tenant isolation enforced
by the database rather than by application code.

> **Status: Milestone 5 of 10 — retrieval, grounded answers, evaluation.**
>
> Working end to end over HTTP: document upload with tenant-scoped storage,
> ingestion into chunks and embeddings, hybrid retrieval, and a streamed answer
> endpoint that withholds anything it cannot cite. Tenant isolation is enforced
> by PostgreSQL row-level security, and 95 integration tests run against a real
> Supabase stack in CI.
>
> **There is no browser interface.** Everything below is reachable over the API
> with a Supabase access token; the homepage is a placeholder and sign-in is a
> `curl` away, not a form. That is the next thing to build.
>
> Retrieval quality is measured rather than asserted — see
> [`evals/reports/`](evals/reports/). Sections marked _(Mn)_ describe what a
> later milestone will add.

## Why it is built this way

**Tenant isolation belongs to PostgreSQL.** Every tenant table runs with both
`ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` — `ENABLE` alone
still exempts the table owner, and migrations run as the owner. User requests
execute inside a transaction that sets the verified JWT claims transaction-locally
and switches to a fixed `authenticated` role that is `NOBYPASSRLS`, non-owner
and unable to migrate. A bug in a route handler is then a bug, not a data
breach.

The runtime credential is also `NOINHERIT` and holds no table grants of its own,
so a query issued outside the claims helper fails with a permission error rather
than returning unfiltered rows. Forgetting the helper breaks an endpoint; it
does not leak a tenant.

**One implementation of the security-critical path.** The Python service is a
pure model service: it parses bytes, embeds text and generates tokens. It holds
no database credentials and runs no tenant query — including the vector search,
which is just SQL and stays in the Node application. There is exactly one place
where the RLS transaction contract is written, and one suite of cross-tenant
tests that has to hold. `services/ai/tests/test_boundary.py` fails the build if
a database driver is ever added to the Python service.

**Confidential documents do not leave the machine.** Embeddings and generation
run locally. The hosted provider is reachable only for workspaces explicitly
marked synthetic, and there is no fallback path from confidential mode to it —
a provider failure produces a deterministic local answer or an abstention, never
a silent upload.

**An answer without evidence is not an answer.** Citations are validated after
generation, against the evidence actually placed in the context. A citation that
does not resolve, or resolves outside the workspace, invalidates the answer and
the system abstains instead — and because validity is a property of the finished
answer, tokens are withheld until it has passed, rather than streamed and then
retracted.

The confidence threshold the plan called for was measured and **not** built: no
floor on the fused score, on cosine similarity or on `ts_rank_cd` separates
answerable questions from unanswerable ones on the evaluation corpus. Refusal is
semantic instead — the generator reads the passages and declines. Measured with
a real model: 5/5 unanswerable questions refused, 21/22 answerable answered.
[The measurement](evals/reports/2026-08-07-abstention-and-injection.md).

## Architecture

```
Browser
   │
   ▼
Next.js  ── owns all tenant SQL, RLS transaction contract, storage, auth
   │                                    │
   │  parse / embed / generate          │  every tenant query
   ▼                                    ▼
FastAPI  ── no database access     PostgreSQL + pgvector
   │
   ▼
Ollama (local models)
```

| Package              | Contents                                                     |
| -------------------- | ------------------------------------------------------------ |
| `apps/product-api`   | Next.js application — UI, product API, all tenant-scoped SQL |
| `services/ai`        | FastAPI model service — parse, embed, generate. No DB access |
| `packages/contracts` | Zod schemas shared across the Node ↔ Python boundary         |
| `packages/database`  | Drizzle schema and migrations                                |
| `packages/config`    | Shared TypeScript configuration                              |
| `evals/`             | Versioned evaluation dataset and reports _(M5, M8)_          |
| `infrastructure/`    | Compose, database initialisation, observability config       |

## Requirements

- Node 20.9+ and pnpm 10 (`corepack enable`)
- Python 3.11 or 3.12 and [uv](https://docs.astral.sh/uv/)
- Docker, for PostgreSQL with pgvector
- [Ollama](https://ollama.com), running natively

Nothing here requires a paid account.

## Quick start

```bash
cp .env.example .env
```

```bash
docker compose up -d postgres
```

```bash
pnpm install && pnpm --filter @clientatlas/database run db:migrate
```

```bash
pnpm --filter @clientatlas/product-api dev
```

```bash
cd services/ai && uv sync --all-groups && uv run uvicorn app.main:app --reload --port 8000
```

The web application is then on <http://localhost:3000> and the model service on
<http://localhost:8000/health/live>.

### Ollama

Run Ollama natively rather than in Docker. A Linux container on Apple Silicon
gets no GPU access, so a containerised Ollama falls back to CPU inference and is
several times slower.

```bash
ollama pull qwen3:8b
```

A compose profile exists for hosts with no native install:
`docker compose --profile ollama up -d`.

## Commands

| Command                                                       | Effect                                            |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `pnpm dev`                                                    | Next.js development server                        |
| `pnpm lint`                                                   | ESLint across the workspace                       |
| `pnpm typecheck`                                              | `tsc --noEmit` across every package               |
| `pnpm test`                                                   | Unit tests — no database needed                   |
| `pnpm build`                                                  | Next.js production build                          |
| `pnpm format`                                                 | Prettier, write                                   |
| `pnpm --filter @clientatlas/database run db:generate`         | Generate a migration from the schema              |
| `pnpm --filter @clientatlas/database run db:migrate`          | Apply migrations as `clientatlas_migration`       |
| `pnpm --filter @clientatlas/product-api run test:integration` | Cross-tenant isolation suite — needs the database |

From `services/ai`:

| Command                | Effect            |
| ---------------------- | ----------------- |
| `uv run ruff check .`  | Lint              |
| `uv run ruff format .` | Format            |
| `uv run mypy`          | Strict type check |
| `uv run pytest`        | Tests             |

CI runs all of the above on every pull request.

## Data handling

Deletion removes a document from active application storage, its database rows,
its chunks, its vectors and its caches. It does not claim to remove it from a
hosting provider's backups, because that is not something this application can
verify. _(M3, M5)_

Logs never contain document text, prompts, access tokens, JWTs or API keys.

## Roadmap

| Milestone | Scope                                                     | Status  |
| --------- | --------------------------------------------------------- | ------- |
| M1        | Monorepo, both services, local database, CI               | Done    |
| M2        | Roles, organisations, workspaces, RLS, claims helper      | Done    |
| M3        | PDF/DOCX upload, signed URLs, storage policies            | Done    |
| M4        | Job queue, worker, parsing, chunking, embeddings          | Done    |
| M5        | Hybrid retrieval, streamed answers, citations, abstention | Done    |
| —         | Browser UI and sign-in                                    | Next    |
| M6        | Onboarding brief, FAQ, action plan, readiness report      | Planned |
| M7        | Google Drive import via Picker with `drive.file`          | Planned |
| M8        | Evaluation suite, OpenTelemetry, Grafana                  | Planned |
| M9        | Synthetic read-only public demo                           | Planned |
| M10       | RFC, threat model, runbooks, evaluation report            | Planned |
