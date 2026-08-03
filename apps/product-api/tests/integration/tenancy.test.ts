import * as schema from "@clientatlas/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InvalidTokenError, verifyAccessToken } from "@/lib/auth/claims";
import {
  getRuntimeDatabase,
  getRuntimeSql,
  readRuntimeRoleAttributes,
} from "@/lib/database/client";
import { readTenantContext, withTenantContext } from "@/lib/database/tenant";

import { expectRejection, expectRowLevelSecurityViolation } from "./helpers/errors";
import { createTenant, truncateTenantTables, type Tenant } from "./helpers/fixtures";
import { mintAccessToken } from "./helpers/tokens";

/**
 * Tenant isolation, asserted against a real PostgreSQL.
 *
 * The point of these tests is that they would fail loudly if the row-level
 * security work were quietly undone — by a dropped policy, a table added
 * without FORCE, a connection string pointed at a privileged role, or a query
 * written outside the claims helper.
 */

let alpha: Tenant;
let beta: Tenant;

beforeAll(async () => {
  await truncateTenantTables();
  alpha = await createTenant("alpha");
  beta = await createTenant("beta");
});

afterAll(async () => {
  await truncateTenantTables();
  await getRuntimeSql().end({ timeout: 5 });
});

describe("the claims helper", () => {
  it("assumes the authenticated role and exposes the token subject", async () => {
    const context = await withTenantContext(alpha.claims, readTenantContext);

    expect(context.currentRole).toBe("authenticated");
    expect(context.currentUserId).toBe(alpha.userId);
  });

  it("leaves no usable state on the connection after the transaction", async () => {
    await withTenantContext(alpha.claims, readTenantContext);

    const [row] = await getRuntimeSql()<{ role: string; claims: string | null }[]>`
      select current_user as role,
             current_setting('request.jwt.claims', true) as claims
    `;

    // The role switch is gone: SET LOCAL ROLE ends with the transaction.
    expect(row?.role).toBe("clientatlas_runtime");

    // PostgreSQL resets a SET LOCAL custom GUC to the empty string rather than
    // removing it, so the assertion is "carries no subject", not "is null".
    // app.current_user_id() applies NULLIF over it, so empty means every policy
    // still evaluates to false.
    expect(row?.claims ?? "").toBe("");
  });

  it("does not leak claims between transactions on a pooled connection", async () => {
    // The real risk with a connection pool: request two borrows the connection
    // request one just used. Transaction-locality is what makes that safe, and
    // this is the test that would fail if SET LOCAL were ever relaxed to SET.
    const first = await withTenantContext(alpha.claims, readTenantContext);
    const second = await withTenantContext(beta.claims, readTenantContext);
    const third = await withTenantContext(alpha.claims, readTenantContext);

    expect(first.currentUserId).toBe(alpha.userId);
    expect(second.currentUserId).toBe(beta.userId);
    expect(third.currentUserId).toBe(alpha.userId);
  });

  it("denies tenant queries issued outside it", async () => {
    // clientatlas_runtime is NOINHERIT and holds no table grants of its own, so
    // forgetting the helper produces a permission error rather than a leak.
    await expectRejection(
      getRuntimeDatabase().select().from(schema.organizations),
      /permission denied/i,
    );
  });
});

describe("tenant reads", () => {
  it("shows a user only their own organization", async () => {
    const rows = await withTenantContext(alpha.claims, (tx) =>
      tx.select({ id: schema.organizations.id }).from(schema.organizations),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(alpha.organizationId);
  });

  it("returns nothing when reading another tenant's organization by id", async () => {
    const rows = await withTenantContext(alpha.claims, (tx) =>
      tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, beta.organizationId)),
    );

    expect(rows).toEqual([]);
  });

  it("returns nothing when reading another tenant's workspace by id", async () => {
    const rows = await withTenantContext(alpha.claims, (tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, beta.workspaceId)),
    );

    expect(rows).toEqual([]);
  });

  it("hides another tenant's membership rows", async () => {
    const rows = await withTenantContext(alpha.claims, (tx) =>
      tx
        .select({ id: schema.organizationMembers.id })
        .from(schema.organizationMembers)
        .where(eq(schema.organizationMembers.organizationId, beta.organizationId)),
    );

    expect(rows).toEqual([]);
  });

  it("hides another user's profile", async () => {
    const rows = await withTenantContext(alpha.claims, (tx) =>
      tx.select({ id: schema.profiles.id }).from(schema.profiles),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(alpha.userId);
  });

  it("reports non-membership through the security-definer helper", async () => {
    const [own, other] = await withTenantContext(alpha.claims, async (tx) => {
      const rows = await tx.execute<{ own: boolean; other: boolean }>(
        sql`select app.is_org_member(${alpha.organizationId}::uuid) as own,
                   app.is_org_member(${beta.organizationId}::uuid) as other`,
      );
      const row = Array.from(rows as Iterable<{ own: boolean; other: boolean }>)[0];
      return [row?.own, row?.other] as const;
    });

    expect(own).toBe(true);
    expect(other).toBe(false);
  });
});

describe("tenant writes", () => {
  it("rejects inserting a workspace into another tenant's organization", async () => {
    await expectRowLevelSecurityViolation(
      withTenantContext(alpha.claims, (tx) =>
        tx.insert(schema.workspaces).values({
          organizationId: beta.organizationId,
          name: "smuggled",
          slug: "smuggled",
        }),
      ),
    );
  });

  it("rejects granting itself membership of another tenant's organization", async () => {
    await expectRowLevelSecurityViolation(
      withTenantContext(alpha.claims, (tx) =>
        tx.insert(schema.organizationMembers).values({
          organizationId: beta.organizationId,
          userId: alpha.userId,
          role: "owner",
        }),
      ),
    );
  });

  it("updates no rows when targeting another tenant's organization", async () => {
    const updated = await withTenantContext(alpha.claims, (tx) =>
      tx
        .update(schema.organizations)
        .set({ name: "renamed by another tenant" })
        .where(eq(schema.organizations.id, beta.organizationId))
        .returning({ id: schema.organizations.id }),
    );

    expect(updated).toEqual([]);

    const [survivor] = await withTenantContext(beta.claims, (tx) =>
      tx
        .select({ name: schema.organizations.name })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, beta.organizationId)),
    );

    expect(survivor?.name).toBe("beta organization");
  });

  it("deletes no rows when targeting another tenant's workspace", async () => {
    const deleted = await withTenantContext(alpha.claims, (tx) =>
      tx
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.id, beta.workspaceId))
        .returning({ id: schema.workspaces.id }),
    );

    expect(deleted).toEqual([]);

    const [survivor] = await withTenantContext(beta.claims, (tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, beta.workspaceId)),
    );

    expect(survivor?.id).toBe(beta.workspaceId);
  });

  it("rejects moving a workspace into another tenant's organization", async () => {
    // The UPDATE policy repeats the organization check in WITH CHECK, so the
    // owner of a workspace still cannot re-parent it across a tenant boundary.
    await expectRowLevelSecurityViolation(
      withTenantContext(alpha.claims, (tx) =>
        tx
          .update(schema.workspaces)
          .set({ organizationId: beta.organizationId })
          .where(eq(schema.workspaces.id, alpha.workspaceId)),
      ),
    );
  });

  it("permits a member to work inside their own organization", async () => {
    // The mirror image of every test above: the policies must still allow the
    // legitimate case, or isolation would be trivially satisfied by denying
    // everything.
    const created = await withTenantContext(alpha.claims, (tx) =>
      tx
        .insert(schema.workspaces)
        .values({ organizationId: alpha.organizationId, name: "second", slug: "second" })
        .returning({ id: schema.workspaces.id }),
    );

    expect(created).toHaveLength(1);

    const visible = await withTenantContext(alpha.claims, (tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.organizationId, alpha.organizationId),
            eq(schema.workspaces.slug, "second"),
          ),
        ),
    );

    expect(visible).toHaveLength(1);
  });
});

describe("credential and schema posture", () => {
  it("serves requests as a role that cannot bypass row-level security", async () => {
    const role = await readRuntimeRoleAttributes();

    expect(role.roleName).toBe("clientatlas_runtime");
    expect(role.isSuperuser).toBe(false);
    expect(role.canBypassRls).toBe(false);
    // NOINHERIT is what makes "forgot the claims helper" a permission error.
    expect(role.inheritsPrivileges).toBe(false);
  });

  it("has row-level security enabled and forced on every tenant table", async () => {
    const rows = await getRuntimeSql()<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `;

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // ENABLE alone still exempts the table owner, and migrations run as the
      // owner — so FORCE is the half that actually closes the gap.
      expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} does not force RLS`).toBe(true);
    }
  });

  it("does not own the tables it queries", async () => {
    const rows = await getRuntimeSql()<{ relname: string; owner: string }[]>`
      select c.relname, pg_get_userbyid(c.relowner) as owner
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `;

    for (const row of rows) {
      expect(row.owner, `${row.relname} is owned by the runtime role`).not.toBe(
        "clientatlas_runtime",
      );
      expect(row.owner).toBe("clientatlas_migration");
    }
  });
});

describe("token verification", () => {
  it("accepts a well-formed authenticated token", async () => {
    const claims = await verifyAccessToken(alpha.token);

    expect(claims.sub).toBe(alpha.userId);
    expect(claims.role).toBe("authenticated");
  });

  it("rejects a service_role token on the user request path", async () => {
    const token = await mintAccessToken({ sub: alpha.userId, role: "service_role" });

    await expect(verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects an expired token", async () => {
    const token = await mintAccessToken({ sub: alpha.userId, expiresInSeconds: -60 });

    await expect(verifyAccessToken(token)).rejects.toThrow(/exp/i);
  });

  it("rejects a token whose subject is not a UUID", async () => {
    const token = await mintAccessToken({ sub: "not-a-uuid" });

    await expect(verifyAccessToken(token)).rejects.toThrow(/UUID/i);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = await mintAccessToken({ sub: alpha.userId });
    const tampered = `${forged.slice(0, -3)}aaa`;

    await expect(verifyAccessToken(tampered)).rejects.toThrow(InvalidTokenError);
  });
});
