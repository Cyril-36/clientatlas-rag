import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as listWorkspaces } from "@/app/api/workspaces/route";
import { getRuntimeSql } from "@/lib/database/client";

import { createTenant, truncateTenantTables, type Tenant } from "./helpers/fixtures";

/**
 * The workspace list, under row-level security.
 *
 * This route carries no membership predicate — the policy on `workspaces` is
 * the whole of the rule, deliberately, because a filter that looks load-bearing
 * and is not is worse than none. That design is only safe if something proves
 * the policy actually scopes it, which is what this file is for. Without it,
 * deleting the policy would leave every test green and every tenant's
 * workspaces visible to everyone.
 */

let alpha: Tenant;
let beta: Tenant;

beforeAll(async () => {
  await truncateTenantTables();
  alpha = await createTenant("workspaces-alpha");
  beta = await createTenant("workspaces-beta");
});

afterAll(async () => {
  await truncateTenantTables();
  await getRuntimeSql().end({ timeout: 5 });
});

function request(token: string | null): Request {
  return new Request("http://localhost/api/workspaces", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

interface Body {
  workspaces?: { id: string; name: string; organizationName: string }[];
}

describe("GET /api/workspaces", () => {
  it("returns the caller's own workspace", async () => {
    const response = await listWorkspaces(request(alpha.token));
    const body = (await response.json()) as Body;

    expect(response.status).toBe(200);
    expect(body.workspaces?.map((w) => w.id)).toEqual([alpha.workspaceId]);
  });

  it("does not return another tenant's workspace", async () => {
    // The assertion that matters. Both tenants exist and both have a workspace;
    // each caller must see exactly one.
    const response = await listWorkspaces(request(beta.token));
    const body = (await response.json()) as Body;

    const ids = body.workspaces?.map((w) => w.id) ?? [];

    expect(ids).toEqual([beta.workspaceId]);
    expect(ids).not.toContain(alpha.workspaceId);
  });

  it("does not leak another tenant's organisation name", async () => {
    // The join reaches `organizations`, which is a second table with its own
    // policy. A workspace row correctly withheld while its organisation's name
    // came back would still be a disclosure.
    const response = await listWorkspaces(request(beta.token));
    const body = (await response.json()) as Body;

    const names = body.workspaces?.map((w) => w.organizationName) ?? [];

    expect(names.some((name) => name.includes("workspaces-alpha"))).toBe(false);
  });

  it("refuses an unauthenticated request", async () => {
    expect((await listWorkspaces(request(null))).status).toBe(401);
  });
});
