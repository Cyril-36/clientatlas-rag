import { expect, test, type Page } from "@playwright/test";

import { createUser, deleteUser, seedReadyDocument, type E2EUser } from "./fixtures";

/**
 * The product, through a browser, as a signed-in person.
 *
 * Everything here goes through the real stack: Supabase Auth issues an ES256
 * token, the BFF puts it in an HttpOnly cookie, the browser carries it, RLS
 * scopes the queries, and the answer is withheld unless its citations resolve.
 * Nothing is minted or stubbed.
 */

const ANSWER = "Reimbursement claims must be filed within 30 days of the expense.";

let alpha: E2EUser;
let beta: E2EUser;

test.beforeAll(async () => {
  alpha = await createUser("alpha");
  beta = await createUser("beta");

  await seedReadyDocument(alpha, "Alpha expenses handbook", ANSWER);
  await seedReadyDocument(beta, "Beta confidential handbook", "Beta reimburses within 90 days.");
});

test.afterAll(async () => {
  await deleteUser(alpha);
  await deleteUser(beta);
});

/**
 * Make a request from inside the page, not from Playwright's request context.
 *
 * `page.request` keeps its own cookie jar and will not send a `Secure` cookie
 * over plain HTTP. The browser will, because Chromium treats 127.0.0.1 as a
 * secure context — so an API assertion made through `page.request` arrived
 * unauthenticated and was answered 401 for a reason that had nothing to do with
 * what it claimed to test. Every such assertion would have passed against a
 * server with no isolation at all.
 */
async function fromPage(
  page: Page,
  path: string,
  init?: { method?: string; origin?: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        method: init?.method ?? "GET",
        credentials: "same-origin",
        headers: init?.body ? { "content-type": "application/json" } : {},
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      });

      return { status: response.status, body: await response.text() };
    },
    { path, init },
  );
}

async function signIn(page: Page, user: E2EUser): Promise<void> {
  await page.goto("/workspace");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByTestId("signed-in-as")).toHaveText(user.email);
}

test("sign in, see documents, ask, read a cited answer, sign out", async ({ page }) => {
  await signIn(page, alpha);

  // The workspace list came from the server under RLS.
  await expect(page.getByLabel("Workspace")).toContainText(alpha.workspaceName);
  await expect(page.getByTestId("documents")).toContainText("Alpha expenses handbook");
  await expect(page.getByTestId("documents")).toContainText("ready");

  await page.getByLabel("Question").fill("When must reimbursement claims be filed?");
  await page.getByTestId("ask").click();

  // The model runs locally and takes as long as it takes. What matters is that
  // an answer arrives with a citation attached, not how quickly.
  await expect(page.getByTestId("answer")).toBeVisible({ timeout: 280_000 });
  await expect(page.getByTestId("citations")).toContainText("Alpha expenses handbook");

  // A citation is a link to the document it came from.
  await expect(page.getByTestId("citation-1")).toBeVisible();

  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("a reload keeps the session", async ({ page }) => {
  // The page cannot read an HttpOnly cookie, so without a server-side status
  // check a reload showed the sign-in form to someone already signed in.
  await signIn(page, alpha);

  await page.reload();

  await expect(page.getByTestId("signed-in-as")).toHaveText(alpha.email);
  await expect(page.getByLabel("Workspace")).toContainText(alpha.workspaceName);
});

test("an expired access token is refreshed rather than shown as a logout", async ({
  page,
  context,
}) => {
  await signIn(page, alpha);

  // Drop only the access cookie, keeping the refresh cookie. That is exactly
  // the state a session reaches after about an hour, without waiting an hour.
  const kept = (await context.cookies()).filter((cookie) => cookie.name !== "clientatlas_access");
  await context.clearCookies();
  await context.addCookies(kept);

  await page.reload();

  await expect(page.getByTestId("signed-in-as")).toHaveText(alpha.email);
});

test("signing out revokes the refresh token, not just the cookie", async ({ page, context }) => {
  // The bug this covers: cookies cleared, refresh token still live for thirty
  // days, so anything that had captured it could keep minting access tokens.
  await signIn(page, alpha);

  const refresh = (await context.cookies()).find((c) => c.name === "clientatlas_refresh");
  expect(refresh?.value).toBeTruthy();

  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.getByLabel("Password")).toBeVisible();

  // Put the captured refresh token back and try to use it directly.
  await context.addCookies([
    {
      name: "clientatlas_refresh",
      value: refresh!.value,
      domain: "127.0.0.1",
      path: "/api/auth/session",
    },
  ]);

  const response = await fromPage(page, "/api/auth/session", { method: "PUT" });

  expect(response.status).toBe(401);
});

test("another signed-in user cannot see the first user's workspace or documents", async ({
  page,
}) => {
  await signIn(page, beta);

  const workspaces = page.getByLabel("Workspace");

  await expect(workspaces).toContainText(beta.workspaceName);
  await expect(workspaces).not.toContainText(alpha.workspaceName);

  const documents = page.getByTestId("documents");

  await expect(documents).toContainText("Beta confidential handbook");
  await expect(documents).not.toContainText("Alpha expenses handbook");
});

test("another user cannot reach the first user's workspace by its id", async ({ page }) => {
  // Selecting is a UI affordance; the guarantee has to hold when the id is
  // supplied directly, which is what an attacker would do.
  await signIn(page, beta);

  // Beta's own workspace first, through the same request context. Without this
  // the test below could pass because the request carried no session at all —
  // an unauthenticated 401 proves nothing about isolation, and a refusal for
  // the wrong reason is the easiest way to write a test that guards nothing.
  const own = await fromPage(page, `/api/workspaces/${beta.workspaceId}/documents`);

  expect(own.status).toBe(200);
  expect(own.body).toContain("Beta confidential handbook");

  const documents = await fromPage(page, `/api/workspaces/${alpha.workspaceId}/documents`);

  // 200 with nothing in it. The list route carries no membership predicate on
  // purpose — row-level security scopes the query, so a foreign workspace id
  // simply matches no rows. The write path answers 404 instead, because it has
  // to resolve the workspace before inserting. Both refuse; only the shape
  // differs, and what is asserted is the part that matters.
  expect(documents.status).toBe(200);
  expect(JSON.parse(documents.body)).toEqual({ documents: [] });
  expect(documents.body).not.toContain("Alpha expenses handbook");

  const answer = await fromPage(page, `/api/workspaces/${alpha.workspaceId}/answers`, {
    method: "POST",
    body: { question: "When must reimbursement claims be filed?" },
  });

  // Nothing retrievable means nothing to answer from — an abstention, never
  // alpha's content.
  expect(answer.body).not.toContain("30 days");
  expect(answer.body).toContain("abstained");
});

test("a cross-site state-changing request is refused", async ({ page }) => {
  await signIn(page, alpha);

  const response = await page.request.post(`/api/workspaces/${alpha.workspaceId}/answers`, {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: { question: "anything" },
  });

  expect(response.status()).toBe(403);
});
