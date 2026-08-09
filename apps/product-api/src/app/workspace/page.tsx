"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The whole product, in one page.
 *
 * Sign in, pick a workspace, upload a document, watch it ingest, ask a
 * question, read an answer whose citations you can click. Nothing more: this
 * exists so the system can be used and demonstrated, not to be a design
 * artefact, and every element on it corresponds to something the API already
 * does.
 *
 * Two things it deliberately does not do.
 *
 * It never touches a token. Sign-in posts to `/api/auth/session`, which sets
 * `HttpOnly` cookies; this component cannot read them and neither can anything
 * else that runs on the page. Every request below is a same-origin `fetch` with
 * `credentials: "same-origin"`, and the browser attaches the session itself.
 *
 * It never renders document text as HTML. Passages arrive from files strangers
 * uploaded, and they are placed in the DOM as text nodes through JSX
 * interpolation — never `dangerouslySetInnerHTML`, never a markdown renderer
 * that emits raw HTML. A document containing a `<script>` tag is displayed as
 * the characters of a script tag.
 */

interface Workspace {
  id: string;
  name: string;
  organizationName: string;
}

interface DocumentRow {
  id: string;
  title: string;
  status: string;
}

interface Citation {
  ordinal: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number | null;
}

type AnswerState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answered"; text: string; citations: Citation[] }
  | { kind: "abstained"; reason: string }
  | { kind: "failed"; message: string };

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { ...init, credentials: "same-origin" });
}

export default function WorkspacePage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AnswerState>({ kind: "idle" });
  const [uploadError, setUploadError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const loadWorkspaces = useCallback(async () => {
    const response = await api("/api/workspaces");
    if (!response.ok) return;

    // `okResponse` returns the payload directly; there is no `data` envelope.
    const body = (await response.json()) as { workspaces?: Workspace[] };
    const found = body.workspaces ?? [];

    setWorkspaces(found);
    setWorkspaceId((current) => current || (found[0]?.id ?? ""));
  }, []);

  const fetchDocuments = useCallback(async (id: string): Promise<DocumentRow[] | null> => {
    if (!id) return null;

    const response = await api(`/api/workspaces/${id}/documents`);
    if (!response.ok) return null;

    const body = (await response.json()) as { documents?: DocumentRow[] };
    return body.documents ?? [];
  }, []);

  // Reloaded on every workspace change, and the result is discarded if the
  // selection moved on while the request was in flight. Without the flag, two
  // quick switches race and the slower response wins — showing one workspace's
  // documents under another's name, which in a multi-tenant product looks
  // exactly like a data leak even when it is only a stale render.
  useEffect(() => {
    let current = true;

    void (async () => {
      const rows = await fetchDocuments(workspaceId);
      if (current && rows) setDocuments(rows);
    })();

    return () => {
      current = false;
    };
  }, [workspaceId, fetchDocuments]);

  // Ingestion is a background job, so the list is polled while anything is
  // still moving. It stops on its own once everything has settled rather than
  // running for as long as the tab is open.
  useEffect(() => {
    const pending = documents.some((d) => d.status === "queued" || d.status === "processing");
    if (!pending || !workspaceId) return;

    const timer = setInterval(() => {
      void (async () => {
        const rows = await fetchDocuments(workspaceId);
        if (rows) setDocuments(rows);
      })();
    }, 2000);

    return () => clearInterval(timer);
  }, [documents, workspaceId, fetchDocuments]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setAuthError(null);

    const response = await api("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      setAuthError("Those credentials were not accepted.");
      return;
    }

    const body = (await response.json()) as { user?: { email?: string | null } };
    setSignedInAs(body.user?.email ?? email);
    setPassword("");
    await loadWorkspaces();
  }

  async function signOut() {
    await api("/api/auth/session", { method: "DELETE" });
    setSignedInAs(null);
    setWorkspaces([]);
    setWorkspaceId("");
    setDocuments([]);
    setAnswer({ kind: "idle" });
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    setUploadError(null);

    const file = fileInput.current?.files?.[0];
    if (!file || !workspaceId) return;

    const form = new FormData();
    form.append("file", file);

    const response = await api(`/api/workspaces/${workspaceId}/documents`, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setUploadError(body.message ?? "The upload was rejected.");
      return;
    }

    if (fileInput.current) fileInput.current.value = "";

    const rows = await fetchDocuments(workspaceId);
    if (rows) setDocuments(rows);
  }

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim() || !workspaceId) return;

    setAnswer({ kind: "asking" });

    const response = await api(`/api/workspaces/${workspaceId}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });

    if (!response.ok || !response.body) {
      setAnswer({ kind: "failed", message: "The question could not be sent." });
      return;
    }

    // The server withholds answer text until citations have been validated, so
    // tokens arrive in a burst rather than progressively. They are still read
    // as a stream because that is what the endpoint speaks.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        const line = frame.split("\n").find((part) => part.startsWith("data: "));
        if (!line) continue;

        const event = JSON.parse(line.slice(6)) as
          | { type: "token"; text: string }
          | { type: "done"; citations: Citation[] }
          | { type: "abstained"; reason: string }
          | { type: "error"; message: string };

        if (event.type === "token") text += event.text;
        if (event.type === "done")
          setAnswer({ kind: "answered", text, citations: event.citations });
        if (event.type === "abstained") setAnswer({ kind: "abstained", reason: event.reason });
        if (event.type === "error") setAnswer({ kind: "failed", message: event.message });
      }
    }
  }

  if (!signedInAs) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
        <h1 className="text-2xl font-semibold tracking-tight">ClientAtlas</h1>

        <form onSubmit={signIn} className="flex flex-col gap-3" data-testid="sign-in-form">
          <input
            type="email"
            required
            placeholder="Email"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            type="password"
            required
            placeholder="Password"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Sign in
          </button>
        </form>

        {authError ? (
          <p role="alert" className="text-sm text-red-600">
            {authError}
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">ClientAtlas</h1>
        <div className="flex items-center gap-3 text-sm">
          <span data-testid="signed-in-as" className="text-zinc-500">
            {signedInAs}
          </span>
          <button onClick={signOut} className="underline underline-offset-4">
            Sign out
          </button>
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <label htmlFor="workspace" className="text-sm font-medium">
          Workspace
        </label>
        <select
          id="workspace"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.organizationName} — {w.name}
            </option>
          ))}
        </select>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Documents</h2>

        <form onSubmit={upload} className="flex items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            aria-label="Document"
            accept=".pdf,.docx"
            className="text-sm"
          />
          <button type="submit" className="rounded-md border px-3 py-1.5 text-sm">
            Upload
          </button>
        </form>

        {uploadError ? (
          <p role="alert" className="text-sm text-red-600">
            {uploadError}
          </p>
        ) : null}

        <ul data-testid="documents" className="flex flex-col gap-1 text-sm">
          {documents.map((document) => (
            <li key={document.id} className="flex justify-between gap-4">
              {/* Interpolated, so a filename containing markup is shown as text. */}
              <span>{document.title}</span>
              <span data-testid={`status-${document.id}`} className="text-zinc-500">
                {document.status}
              </span>
            </li>
          ))}
          {documents.length === 0 ? <li className="text-zinc-500">Nothing uploaded yet.</li> : null}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <form onSubmit={ask} className="flex flex-col gap-2">
          <label htmlFor="question" className="text-sm font-medium">
            Question
          </label>
          <textarea
            id="question"
            rows={2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            className="w-fit rounded-md bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Ask
          </button>
        </form>

        {answer.kind === "asking" ? <p className="text-sm text-zinc-500">Thinking…</p> : null}

        {answer.kind === "answered" ? (
          <div data-testid="answer" className="flex flex-col gap-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.text}</p>

            <ul data-testid="citations" className="flex flex-col gap-1 text-sm">
              {answer.citations.map((citation) => (
                <li key={citation.chunkId}>
                  <a
                    href={`/api/documents/${citation.documentId}`}
                    data-testid={`citation-${citation.ordinal}`}
                    className="underline underline-offset-4"
                  >
                    [{citation.ordinal}] {citation.documentTitle}
                    {citation.pageNumber === null ? "" : `, page ${citation.pageNumber}`}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* The abstention is a first-class outcome, not an error. It is the
            product working: nothing was found that could be cited, so nothing
            is asserted. Presenting it as a failure would train people to
            distrust the one behaviour that makes the answers worth reading. */}
        {answer.kind === "abstained" ? (
          <p data-testid="abstained" className="rounded-md border border-amber-300 p-3 text-sm">
            No answer. {answer.reason}
          </p>
        ) : null}

        {answer.kind === "failed" ? (
          <p role="alert" data-testid="answer-error" className="text-sm text-red-600">
            {answer.message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
