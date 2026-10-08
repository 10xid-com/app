import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * Agency access, end to end on the server: real sign-in and portal sessions,
 * real grants decided under login's 0025 rules, and the real session
 * resolution, central authorization function, switcher and team actions.
 * Only the browser is stood in for — its cookie and the headers it sends.
 *
 * The story: Branding Centres (an agency) asks for access to Rotary; Rotary's
 * owner approves the grant and the person; the person works in Rotary — and
 * only there, only at the granted role, never able to manage people — until
 * they are blocked, the grant is revoked, it expires, or they leave the agency.
 */

process.env.PORTAL_HOST ||= "app.portal.test";

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Redirect("404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/mailer", () => ({ sendInvitation: vi.fn(async () => {}) }));

const browser = vi.hoisted(() => ({ token: null as string | null, origin: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (browser.token && name.includes("portal_session") ? { name, value: browser.token } : undefined),
    set: () => {},
  }),
  headers: async () => new Headers(browser.origin ? { origin: browser.origin } : {}),
}));

const { resolveIdentity, startSession } = await import("@/lib/auth/session");
const { requirePage } = await import("@/lib/auth/authorize");
const { appOrigin } = await import("@/lib/auth/origin");
const { closePool } = await import("@/lib/db/connection");
const { switchBusinessAction } = await import("@/app/business/actions");
const { inviteAction, changeRoleAction } = await import("@/app/team/actions");
const { createJobAction } = await import("@/app/jobs/actions");

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `aa${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const org: Record<string, string> = {};
const who: Record<string, { userId: string; token: string }> = {};
const authUsers: string[] = [];
let grant = "";

async function organization(key: string) {
  org[key] = (
    await owner.query("insert into organizations (type, name, slug) values ('client', $1, $2) returning id", [`${key} ${TAG}`, `${TAG}-${key}`])
  ).rows[0].id;
}

async function person(key: string, memberOf: [string, string][]) {
  const authUserId = `auth-${key}-${TAG}`;
  authUsers.push(authUserId);
  await owner.query("insert into auth_users (id, name, email) values ($1, 'T', $2)", [authUserId, addr(key)]);
  const authSessionId = randomUUID();
  await owner.query(
    "insert into auth_sessions (id, token, user_id, expires_at) values ($1, $2, $3, now() + interval '7 days')",
    [authSessionId, `token-${authSessionId}`, authUserId],
  );
  await owner.query("update auth_sessions set mfa_verified_at = now() where id = $1", [authSessionId]);
  const userId = (await owner.query("insert into users (email, auth_user_id) values ($1, $2) returning id", [addr(key), authUserId])).rows[0]
    .id as string;
  for (const [o, role] of memberOf) {
    await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, $3)", [userId, org[o], role]);
  }
  const { token } = await startSession({ userId, host: "app.test", authSessionId, hardEnd: new Date(Date.now() + 7 * 86_400_000) });
  who[key] = { userId, token };
}

function as(key: string) {
  browser.token = who[key]!.token;
  browser.origin = appOrigin();
}

async function outcome(fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    return r === undefined ? "returned" : r;
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    return `error: ${(e as Error).message}`;
  }
}

async function form(fields: Record<string, string> = {}) {
  const f = new FormData();
  const identity = await resolveIdentity();
  if (identity.state === "active") f.set("csrf", identity.csrfToken);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** What the person sees: their open business, and every one they may open. */
async function seen() {
  const identity = await resolveIdentity();
  if (identity.state !== "active") return { open: "signed out", reach: [] as string[] };
  return {
    open: identity.ctx.scope.organizationId,
    reach: identity.ctx.agencyAccess.map((a) => a.organizationId),
  };
}

const page = (action: Parameters<typeof requirePage>[0], businessId?: string) =>
  outcome(async () => {
    const g = await requirePage(action, { returnPath: "/jobs", businessId });
    return { business: g.businessId, role: g.role, via: g.via?.grantId ?? null };
  });

const setPerson = (status: string, by: string) =>
  owner.query("update agency_grant_people set status = $3, decided_by = $4 where grant_id = $1 and user_id = $2", [
    grant,
    who.worker!.userId,
    status,
    who[by]!.userId,
  ]);

const membershipsOf = async (key: string) =>
  (await owner.query("select organization_id from memberships where user_id = $1", [who[key]!.userId])).rows.map((r) => r.organization_id);

beforeAll(async () => {
  await owner.connect();
  await organization("agency");
  await organization("rotary");
  await organization("northstar");
  await owner.query("update organizations set is_agency = true where id = $1", [org.agency]);
  await person("agency-boss", [["agency", "owner"]]);
  await person("worker", [["agency", "editor"]]);
  await person("rotary-owner", [["rotary", "owner"]]);
  await person("rotary-manager", [["rotary", "manager"]]);
  await person("northstar-owner", [["northstar", "owner"]]);
  await owner.query(
    `insert into jobs (id, organization_id, ref, title, direction, status, created_by)
     values (gen_random_uuid(), $1, $2, 'Northstar secret', 'from_client', 'open', $3)`,
    [org.northstar, `${TAG}-N1`, who["northstar-owner"]!.userId],
  );

  // Branding Centres asks; it names its person.
  grant = (
    await owner.query(
      `insert into agency_grants (client_organization_id, agency_organization_id, reason, requested_by)
       values ($1, $2, 'Website and print work for Rotary', $3) returning id`,
      [org.rotary, org.agency, who["agency-boss"]!.userId],
    )
  ).rows[0].id;
  await owner.query("insert into agency_grant_people (grant_id, user_id, added_by) values ($1, $2, $3)", [
    grant,
    who.worker!.userId,
    who["agency-boss"]!.userId,
  ]);
});

afterAll(async () => {
  const ids = Object.values(org);
  const emails = `%-${TAG}@test.invalid`;
  await owner.query("delete from job_events where organization_id = any($1::uuid[])", [ids]).catch(() => {});
  await owner.query("delete from jobs where organization_id = any($1::uuid[])", [ids]);
  await owner.query("delete from invitations where organization_id = any($1::uuid[])", [ids]);
  await owner.query(
    "delete from agency_grant_people where grant_id in (select id from agency_grants where client_organization_id = any($1::uuid[]))",
    [ids],
  );
  await owner.query("delete from agency_grants where client_organization_id = any($1::uuid[])", [ids]);
  await owner.query("delete from sessions where user_id in (select id from users where email like $1)", [emails]);
  await owner.query("delete from memberships where organization_id = any($1::uuid[])", [ids]);
  await owner.query("delete from user_emails where email like $1", [emails]);
  await owner.query("delete from users where email like $1", [emails]);
  await owner.query("delete from auth_users where id = any($1::text[])", [authUsers]);
  await owner.query("delete from organizations where id = any($1::uuid[])", [ids]);
  await owner.end();
  await closePool();
});

beforeEach(() => {
  browser.token = null;
  browser.origin = null;
});

describe("before the business says yes", () => {
  test("a requested grant, or a requested person, opens nothing", async () => {
    as("worker");
    expect(await seen()).toEqual({ open: org.agency, reach: [] });
    expect(await page("jobs.read", org.rotary)).toBe("/access?reason=not_a_member");
    expect(await outcome(async () => switchBusinessAction(await form({ organizationId: org.rotary! })))).toBe("/business?error=not_yours");
  });

  test("an approved grant whose person is not yet approved still opens nothing", async () => {
    await owner.query(
      "update agency_grants set status = 'active', decided_by = $2, expires_at = now() + interval '90 days' where id = $1",
      [grant, who["rotary-owner"]!.userId],
    );
    as("worker");
    expect((await seen()).reach).toEqual([]);
  });
});

describe("approved", () => {
  test("the person can open the business, at the granted role, marked as agency access", async () => {
    await setPerson("approved", "rotary-owner");
    as("worker");
    expect((await seen()).reach).toEqual([org.rotary]);
    expect(await outcome(async () => switchBusinessAction(await form({ organizationId: org.rotary! })))).toBe("/dashboard");
    expect((await seen()).open).toBe(org.rotary);
    expect(await page("jobs.read")).toEqual({ business: org.rotary, role: "editor", via: grant });
  });

  test("they work in it: an editor can file a job there", async () => {
    as("worker");
    expect(await outcome(async () => createJobAction(await form({ title: "Agency-filed job", direction: "from_client" })))).toBe("/jobs");
    const filed = await owner.query("select created_by from jobs where organization_id = $1 and title = 'Agency-filed job'", [org.rotary]);
    expect(filed.rows[0]?.created_by).toBe(who.worker!.userId);
  });

  test("but never manage its people: no inviting, no role changes — so no memberships", async () => {
    as("worker");
    expect(await outcome(async () => inviteAction(await form({ email: addr("friend"), role: "viewer" })))).toBe(
      "/access?reason=role_lacks_action",
    );
    expect(
      await outcome(async () => changeRoleAction(await form({ userId: who["rotary-manager"]!.userId, role: "viewer" }))),
    ).toBe("/access?reason=role_lacks_action");
    expect(await membershipsOf("worker")).toEqual([org.agency]);
    expect((await owner.query("select count(*)::int as n from invitations where organization_id = $1", [org.rotary])).rows[0].n).toBe(0);
  });

  test("business isolation: Rotary's grant does not reach Northstar, its jobs, or its switcher entry", async () => {
    as("worker");
    expect(await page("jobs.read", org.northstar)).toBe("/access?reason=not_a_member");
    expect(await outcome(async () => switchBusinessAction(await form({ organizationId: org.northstar! })))).toBe(
      "/business?error=not_yours",
    );
    const northstarJob = (await owner.query("select id from jobs where organization_id = $1", [org.northstar])).rows[0].id;
    expect(
      await outcome(async () =>
        requirePage("jobs.read", { returnPath: "/jobs", resource: { type: "job", id: northstarJob } }),
      ),
    ).toBe("404");
  });
});

describe("taken away", () => {
  test("blocked by the business: gone on the next request; unblocked by its owner: back", async () => {
    await setPerson("blocked", "rotary-manager");
    as("worker");
    expect(await seen()).toEqual({ open: org.agency, reach: [] });
    expect(await page("jobs.read", org.rotary)).toBe("/access?reason=not_a_member");
    await setPerson("approved", "rotary-owner");
    expect((await seen()).reach).toEqual([org.rotary]);
  });

  test("leaving the agency ends it, though the grant and the approval stand", async () => {
    await owner.query("delete from memberships where user_id = $1 and organization_id = $2", [who.worker!.userId, org.agency]);
    as("worker");
    expect(await seen()).toEqual({ open: null, reach: [] });
    await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, 'editor')", [
      who.worker!.userId,
      org.agency,
    ]);
    expect((await seen()).reach).toEqual([org.rotary]);
  });

  test("expiry: the day it ends, it is gone, with nothing having to notice", async () => {
    await owner.query("update agency_grants set expires_at = now() - interval '1 second' where id = $1", [grant]);
    as("worker");
    expect((await seen()).reach).toEqual([]);
    expect(await page("jobs.read", org.rotary)).toBe("/access?reason=not_a_member");
  });

  test("revocation: ended by the business, gone; nothing brings it back", async () => {
    // A fresh grant, approved, then revoked.
    await owner.query("update agency_grants set status = 'revoked', revoked_by = $2 where id = $1", [grant, who["rotary-owner"]!.userId]);
    grant = (
      await owner.query(
        `insert into agency_grants (client_organization_id, agency_organization_id, reason, requested_by)
         values ($1, $2, 'Second round of website work', $3) returning id`,
        [org.rotary, org.agency, who["agency-boss"]!.userId],
      )
    ).rows[0].id;
    await owner.query("insert into agency_grant_people (grant_id, user_id, added_by) values ($1, $2, $3)", [
      grant,
      who.worker!.userId,
      who["agency-boss"]!.userId,
    ]);
    await owner.query(
      "update agency_grants set status = 'active', decided_by = $2, expires_at = now() + interval '30 days' where id = $1",
      [grant, who["rotary-owner"]!.userId],
    );
    await setPerson("approved", "rotary-owner");
    as("worker");
    expect((await seen()).reach).toEqual([org.rotary]);

    await owner.query("update agency_grants set status = 'revoked', revoked_by = $2 where id = $1", [grant, who["rotary-manager"]!.userId]);
    expect((await seen()).reach).toEqual([]);
    expect(await page("jobs.read", org.rotary)).toBe("/access?reason=not_a_member");
    await expect(
      owner.query("update agency_grants set status = 'active' where id = $1", [grant]),
    ).rejects.toThrow(/closed/);
  });

  test("throughout, the agency person was never made a member of the business", async () => {
    expect(await membershipsOf("worker")).toEqual([org.agency]);
  });
});
