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

/**
 * Every call the page makes, with one automatic refresh on expiry.
 *
 * Access tokens last about an hour. Without this the page worked until the
 * token aged out and then failed silently for the rest of the session, which is
 * the worst kind of bug to be told about: "it stopped working" with nothing on
 * screen to say why.
 *
 * One retry, not a loop. If a refresh succeeds and the retry still returns 401,
 * the session is genuinely over and asking again would spin.
 *
 * `onExpired` is how the page learns to go back to sign-in rather than sitting
 * there with dead controls.
 */
async function api(
  path: string,
  init: RequestInit | undefined,
  onExpired: () => void,
): Promise<Response> {
  const send = () => fetch(path, { ...init, credentials: "same-origin" });

  let response = await send();

  if (response.status !== 401) return response;

  const refreshed = await fetch("/api/auth/session", {
    method: "PUT",
    credentials: "same-origin",
  });

  if (!refreshed.ok) {
    onExpired();
    return response;
  }

  response = await send();

  if (response.status === 401) onExpired();

  return response;
}

/** True when an abort caused the failure, which is expected and not an error. */
function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export default function WorkspacePage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AnswerState>({ kind: "idle" });
  const [uploadError, setUploadError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Bumped whenever identity or workspace changes, and every in-flight request
   * is aborted with it.
   *
   * A poll or an answer stream started as user A, or in workspace A, must not
   * paint its result after a sign-out or a switch. The consequence is not
   * cosmetic in a multi-tenant product: one tenant's filenames appearing under
   * another's name is indistinguishable, on screen, from a data leak. The
   * controller is the mechanism; `session` is what makes a late response
   * recognisable as belonging to a world that no longer exists.
   */
  const session = useRef(0);
  const inFlight = useRef<AbortController[]>([]);

  const newRequest = useCallback((): AbortController => {
    const controller = new AbortController();
    inFlight.current.push(controller);
    return controller;
  }, []);

  const abortAll = useCallback(() => {
    session.current += 1;
    for (const controller of inFlight.current) controller.abort();
    inFlight.current = [];
  }, []);

  const expired = useCallback(() => {
    abortAll();
    setSignedInAs(null);
    setWorkspaces([]);
    setWorkspaceId("");
    setDocuments([]);
    setAnswer({ kind: "idle" });
    setAuthError("The session expired. Sign in again.");
  }, [abortAll]);

  const call = useCallback(
    (path: string, init?: RequestInit) => api(path, init, expired),
    [expired],
  );

  const loadWorkspaces = useCallback(async () => {
    const response = await call("/api/workspaces");
    if (!response.ok) return;

    // `okResponse` returns the payload directly; there is no `data` envelope.
    const body = (await response.json()) as { workspaces?: Workspace[] };
    const found = body.workspaces ?? [];

    setWorkspaces(found);
    setWorkspaceId((current) => current || (found[0]?.id ?? ""));
  }, [call]);

  // On load, ask the server who we are. The session cookie is HttpOnly, so the
  // page has no other way to find out — and without this a reload showed the
  // sign-in form to someone already signed in.
  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/auth/session", { credentials: "same-origin" });
      const body = (await response.json().catch(() => ({}))) as {
        signedIn?: boolean;
        user?: { email?: string | null };
      };

      if (body.signedIn) {
        setSignedInAs(body.user?.email ?? "signed in");
        await loadWorkspaces();
      } else {
        // A dead access token with a live refresh token is the ordinary state
        // after an hour away. Try once before showing the form.
        const refreshed = await fetch("/api/auth/session", {
          method: "PUT",
          credentials: "same-origin",
        });

        if (refreshed.ok) {
          const user = (await refreshed.json()) as { user?: { email?: string | null } };
          setSignedInAs(user.user?.email ?? "signed in");
          await loadWorkspaces();
        }
      }

      setReady(true);
    })();
  }, [loadWorkspaces]);

  const fetchDocuments = useCallback(
    async (id: string, signal: AbortSignal): Promise<DocumentRow[] | null> => {
      if (!id) return null;

      const response = await call(`/api/workspaces/${id}/documents`, { signal });
      if (!response.ok) return null;

      const body = (await response.json()) as { documents?: DocumentRow[] };
      return body.documents ?? [];
    },
    [call],
  );

  // Reloaded on every workspace change. Clearing the stale answer happens in
  // the select's handler rather than here, so this effect does no synchronous
  // state update on mount.
  useEffect(() => {
    if (!signedInAs) return;

    const generation = session.current;
    const controller = newRequest();

    void (async () => {
      try {
        const rows = await fetchDocuments(workspaceId, controller.signal);
        if (generation === session.current && rows) setDocuments(rows);
      } catch (error) {
        if (!aborted(error)) throw error;
      }
    })();

    return () => controller.abort();
  }, [workspaceId, signedInAs, fetchDocuments, newRequest]);

  // Ingestion is a background job, so the list is polled while anything is
  // still moving, and stops once everything settles.
  useEffect(() => {
    const pending = documents.some((d) => d.status === "queued" || d.status === "processing");
    if (!pending || !workspaceId || !signedInAs) return;

    const generation = session.current;
    const controller = newRequest();

    const timer = setInterval(() => {
      void (async () => {
        try {
          const rows = await fetchDocuments(workspaceId, controller.signal);
          if (generation === session.current && rows) setDocuments(rows);
        } catch (error) {
          if (!aborted(error)) throw error;
        }
      })();
    }, 2000);

    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [documents, workspaceId, signedInAs, fetchDocuments, newRequest]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setAuthError(null);
    setBusy(true);

    try {
      const response = await call("/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setAuthError(body.message ?? "Those credentials were not accepted.");
        return;
      }

      const body = (await response.json()) as { user?: { email?: string | null } };
      setSignedInAs(body.user?.email ?? email);
      setPassword("");
      await loadWorkspaces();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    // Aborted first. A poll or a stream that resolves after sign-out would
    // otherwise repaint tenant data onto a signed-out screen.
    abortAll();

    await fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" });

    setSignedInAs(null);
    setWorkspaces([]);
    setWorkspaceId("");
    setDocuments([]);
    setAnswer({ kind: "idle" });
    setAuthError(null);
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    setUploadError(null);

    const file = fileInput.current?.files?.[0];
    if (!file || !workspaceId || busy) return;

    const generation = session.current;
    const controller = newRequest();
    setBusy(true);

    try {
      const form = new FormData();
      form.append("file", file);

      const response = await call(`/api/workspaces/${workspaceId}/documents`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      if (generation !== session.current) return;

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setUploadError(body.message ?? "The upload was rejected.");
        return;
      }

      if (fileInput.current) fileInput.current.value = "";

      const rows = await fetchDocuments(workspaceId, controller.signal);
      if (generation === session.current && rows) setDocuments(rows);
    } catch (error) {
      if (!aborted(error)) throw error;
    } finally {
      setBusy(false);
    }
  }

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim() || !workspaceId || busy) return;

    const generation = session.current;
    const controller = newRequest();

    setAnswer({ kind: "asking" });
    setBusy(true);

    try {
      const response = await call(`/api/workspaces/${workspaceId}/answers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });

      if (generation !== session.current) return;

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

        // The stream outlived the world it was started in. Stop reading and
        // paint nothing.
        if (generation !== session.current) {
          await reader.cancel();
          return;
        }

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
    } catch (error) {
      if (!aborted(error)) throw error;
    } finally {
      setBusy(false);
    }
  }

  // Nothing is decided until the server has answered who we are. Rendering the
  // sign-in form first would flash it at someone who is already signed in.
  if (!ready) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </main>
    );
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
            disabled={busy}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? "Signing in…" : "Sign in"}
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
          onChange={(e) => {
            // An answer drawn from workspace A's documents, left on screen
            // under workspace B's name, is a claim about the wrong tenant.
            setAnswer({ kind: "idle" });
            setUploadError(null);
            setWorkspaceId(e.target.value);
          }}
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
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
          >
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
            disabled={busy}
            data-testid="ask"
            className="w-fit rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? "Asking…" : "Ask"}
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
                    // The route answers with JSON carrying a short-lived signed
                    // URL, so following the link plainly showed a reader a blob
                    // of JSON. Fetched and followed instead. The signed URL is
                    // deliberately not put in `href`: it would then sit in
                    // browser history and in any `Referer` sent onward, which is
                    // a credential for a tenant's document.
                    onClick={async (clickEvent) => {
                      clickEvent.preventDefault();

                      const response = await call(`/api/documents/${citation.documentId}`);
                      if (!response.ok) return;

                      const body = (await response.json()) as { url?: string };
                      if (body.url) window.open(body.url, "_blank", "noopener,noreferrer");
                    }}
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
