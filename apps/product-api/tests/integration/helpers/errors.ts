import { expect } from "vitest";

/**
 * Drizzle wraps a driver failure in its own error, so the message that actually
 * says "row-level security" is one or two `cause` links down. Asserting on the
 * top-level message alone would silently pass for *any* failed query — which is
 * the worst possible outcome for a test whose job is to prove a write was
 * refused for the right reason.
 */
function errorChain(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);

    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      messages.push(`SQLSTATE ${code}`);
    }

    current = current.cause;
  }

  return messages;
}

/** Asserts the promise rejects, and that some link in the cause chain matches. */
export async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  let settled = false;

  try {
    await promise;
    settled = true;
  } catch (error: unknown) {
    caught = error;
  }

  expect(settled, "expected the statement to be rejected, but it succeeded").toBe(false);

  const chain = errorChain(caught);

  expect(
    chain.some((message) => pattern.test(message)),
    `expected a rejection matching ${pattern}, got:\n  ${chain.join("\n  ")}`,
  ).toBe(true);
}

/** A write refused by a policy: SQLSTATE 42501, insufficient_privilege. */
export function expectRowLevelSecurityViolation(promise: Promise<unknown>): Promise<void> {
  return expectRejection(promise, /row-level security|SQLSTATE 42501/i);
}
