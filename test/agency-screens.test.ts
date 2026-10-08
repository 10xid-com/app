import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

/**
 * Agency access through its screens' server actions, end to end: real
 * sessions, the real central authorization function, and login's 0025 rules
 * underneath. The agency asks and names its people; the business's owner
 * decides; managers can block and end; nobody can decide for a business that
 * is not theirs, and an agency cannot approve itself.
 */

process.env.PORTAL_HOST ||= "app.portal.test";
const SINK = process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";

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

const browser = vi.hoisted(() => ({ token: null as string | null, origin: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (browser.token && name.includes("portal_session") ? { name, value: browser.token } : undefined),
    set: () => {},
  }),
  headers: async () => new Headers(browser.origin ? { origin: browser.origin } : {}),
}));

const { resolveIdentity, startSession } = await import("@/lib/auth/session");
const { appOrigin } = await import("@/lib/auth/origin");
const { closePool } = await import("@/lib/db/connection");
const { setSessionActiveOrganization } = await import("@/lib/db/identity");
const agencySide = await import("@/app/agency/actions");
const businessSide = await import("@/app/team/agency-actions");
const { default: AgencyPage } = await import("@/app/agency/page");
const { default: TeamPage } = await import("@/app/team/page");

/** Every string rendered anywhere in a server component's element tree. */
function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  const el = node as { props?: Record<string, unknown>; type?: unknown };
  // Render plain function components (not async server ones) so their text is in the tree.
  if (typeof el.type === "function" && el.type.constructor.name !== "AsyncFunction") {
    return text((el.type as (p: unknown) => unknown)(el.props));
  }
  return el.props ? Object.values(el.props).map(text).join(" ") : "";
}

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `as${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const org: Record<string, string> = {};
const slug: Record<string, string> = {};
const who: Record<string, { userId: string; token: string; sessionId: string }> = {};
const authUsers: string[] = [];

async function organization(key: string) {
  slug[key] = `${TAG}-${key}`;
  org[key] = (
    await owner.query("insert into organizations (type, name, slug) values ('client', $1, $2) returning id", [`${key} ${TAG}`, slug[key]])
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
  const { token, sessionId } = await startSession({ userId, host: "app.test", authSessionId, hardEnd: new Date(Date.now() + 7 * 86_400_000) });
  who[key] = { userId, token, sessionId };
}

/** Signed in as `key`, with `business` open. */
async function as(key: string, business: string) {
  await setSessionActiveOrganization(who[key]!.sessionId, org[business]!);
  browser.token = who[key]!.token;
  browser.origin = appOrigin();
}

async function act(fn: (f: FormData) => Promise<unknown>, fields: Record<string, string>) {
  const f = new FormData();
  const identity = await resolveIdentity();
  if (identity.state === "active") f.set("csrf", identity.csrfToken);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  try {
    await fn(f);
    return "returned";
  } catch (e) {
    if (e instanceof Redirect) return e.to.replace(/#.*$/, "");
    return `error: ${(e as Error).message}`;
  }
}

const grantFor = async (business: string) =>
  (await owner.query("select * from agency_grants where client_organization_id = $1 order by requested_at desc limit 1", [org[business]]))
    .rows[0];
const personOn = async (grant: string, key: string) =>
  (await owner.query("select status from agency_grant_people where grant_id = $1 and user_id = $2", [grant, who[key]!.userId])).rows[0]
    ?.status;
async function reach(key: string) {
  browser.token = who[key]!.token;
  const identity = await resolveIdentity();
  return identity.state === "active" ? identity.ctx.agencyAccess.map((a) => a.organizationId) : [];
}

beforeAll(async () => {
  await owner.connect();
  for (const k of ["agency", "rotary", "northstar", "plain"]) await organization(k);
  await owner.query("update organizations set is_agency = true where id = $1", [org.agency]);
  await person("agency-boss", [["agency", "owner"]]);
  await person("agency-editor", [["agency", "editor"]]);
  await person("worker", [["agency", "viewer"]]);
  await person("rotary-owner", [["rotary", "owner"]]);
  await person("rotary-manager", [["rotary", "manager"]]);
  await person("northstar-owner", [["northstar", "owner"]]);
  await person("plain-owner", [["plain", "owner"]]);
});

afterAll(async () => {
  const ids = Object.values(org);
  const emails = `%-${TAG}@test.invalid`;
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

describe("the agency asks", () => {
  test("only an agency's owner or manager, with the agency open", async () => {
    await as("agency-editor", "agency");
    expect(await act(agencySide.requestAccessAction, { businessRef: slug.rotary!, reason: "Website and print work" })).toBe(
      "/access?reason=role_lacks_action",
    );
    await as("plain-owner", "plain");
    expect(await act(agencySide.requestAccessAction, { businessRef: slug.rotary!, reason: "Website and print work" })).toBe("404");
    expect(await grantFor("rotary")).toBeUndefined();
  });

  test("asked: a request with the defaults, and the business's owners are told", async () => {
    await as("agency-boss", "agency");
    expect(await act(agencySide.requestAccessAction, { businessRef: slug.rotary!, reason: "Website and print work" })).toBe(
      "/agency?done=asked",
    );
    expect(await grantFor("rotary")).toMatchObject({ status: "requested", role: "editor", duration_days: 90 });
    const sink = await readFile(SINK, "utf8").catch(() => "");
    expect(sink).toContain(`${addr("rotary-owner")}\tAGENCY`);
  });

  test("an unknown reference gets the same answer and asks nothing; a second open request is refused", async () => {
    await as("agency-boss", "agency");
    expect(await act(agencySide.requestAccessAction, { businessRef: "no-such-business", reason: "Website and print work" })).toBe(
      "/agency?done=asked",
    );
    expect(await act(agencySide.requestAccessAction, { businessRef: slug.rotary!, reason: "Website and print work" })).toBe(
      "/agency?error=already_open",
    );
    expect(await act(agencySide.requestAccessAction, { businessRef: slug.northstar!, role: "owner", reason: "Take it over" })).toBe(
      "/agency?error=refused",
    );
  });

  test("it names its own people, and only its own", async () => {
    const g = await grantFor("rotary");
    await as("agency-boss", "agency");
    expect(await act(agencySide.addAgencyPersonAction, { grantId: g.id, userId: who.worker!.userId })).toBe("/agency?done=named");
    expect(await personOn(g.id, "worker")).toBe("requested");
    expect(await act(agencySide.addAgencyPersonAction, { grantId: g.id, userId: who["rotary-manager"]!.userId })).toBe(
      "/agency?error=refused",
    );
  });
});

describe("the business decides", () => {
  test("a manager cannot approve; the owner can, for no longer than was asked", async () => {
    const g = await grantFor("rotary");
    await as("rotary-manager", "rotary");
    expect(await act(businessSide.approveGrantAction, { grantId: g.id, role: "editor", days: "90" })).toBe(
      "/access?reason=role_lacks_action",
    );
    await as("rotary-owner", "rotary");
    expect(await act(businessSide.approveGrantAction, { grantId: g.id, role: "editor", days: "120" })).toBe("/team?agency_error=refused");
    expect(await act(businessSide.approveGrantAction, { grantId: g.id, role: "viewer", days: "30" })).toBe("/team?agency=approved");
    expect(await grantFor("rotary")).toMatchObject({ status: "active", role: "viewer", decided_by: who["rotary-owner"]!.userId });
  });

  test("each person is approved by the owner, not the manager; until then they reach nothing", async () => {
    const g = await grantFor("rotary");
    expect(await reach("worker")).toEqual([]);
    await as("rotary-manager", "rotary");
    expect(
      await act(businessSide.decideAgencyPersonAction, { grantId: g.id, userId: who.worker!.userId, decision: "approved" }),
    ).toBe("/access?reason=role_lacks_action");
    await as("rotary-owner", "rotary");
    expect(
      await act(businessSide.decideAgencyPersonAction, { grantId: g.id, userId: who.worker!.userId, decision: "approved" }),
    ).toBe("/team?agency=person_approved");
    expect(await reach("worker")).toEqual([org.rotary]);
  });

  test("a person named after approval waits for the owner too", async () => {
    const g = await grantFor("rotary");
    await as("agency-boss", "agency");
    expect(await act(agencySide.addAgencyPersonAction, { grantId: g.id, userId: who["agency-editor"]!.userId })).toBe("/agency?done=named");
    expect(await reach("agency-editor")).toEqual([]);
  });

  test("a manager blocks; the owner unblocks", async () => {
    const g = await grantFor("rotary");
    await as("rotary-manager", "rotary");
    expect(await act(businessSide.decideAgencyPersonAction, { grantId: g.id, userId: who.worker!.userId, decision: "blocked" })).toBe(
      "/team?agency=person_blocked",
    );
    expect(await reach("worker")).toEqual([]);
    await as("rotary-owner", "rotary");
    expect(
      await act(businessSide.decideAgencyPersonAction, { grantId: g.id, userId: who.worker!.userId, decision: "approved" }),
    ).toBe("/team?agency=person_approved");
    expect(await reach("worker")).toEqual([org.rotary]);
  });
});

describe("isolation", () => {
  test("another business cannot decide on Rotary's grant, even by its exact id", async () => {
    const g = await grantFor("rotary");
    await as("northstar-owner", "northstar");
    expect(await act(businessSide.revokeGrantAction, { grantId: g.id })).toBe("/team?agency_error=not_found");
    expect(
      await act(businessSide.decideAgencyPersonAction, { grantId: g.id, userId: who.worker!.userId, decision: "blocked" }),
    ).toBe("/team?agency_error=not_found");
    expect((await grantFor("rotary")).status).toBe("active");
  });

  test("the agency cannot approve its own access, or decide its people, from its own business", async () => {
    const g = await grantFor("rotary");
    await as("agency-boss", "agency");
    expect(
      await act(businessSide.decideAgencyPersonAction, { grantId: g.id, userId: who["agency-editor"]!.userId, decision: "approved" }),
    ).toBe("/team?agency_error=not_found");
    expect(await personOn(g.id, "agency-editor")).toBe("requested");
  });

  test("an agency person working in Rotary cannot decide anything there", async () => {
    const g = await grantFor("rotary");
    await as("worker", "rotary");
    for (const decision of ["approved", "blocked"]) {
      expect(
        await act(businessSide.decideAgencyPersonAction, { grantId: g.id, userId: who["agency-editor"]!.userId, decision }),
        decision,
      ).toBe("/access?reason=role_lacks_action");
    }
    expect(await act(businessSide.revokeGrantAction, { grantId: g.id })).toBe("/access?reason=role_lacks_action");
  });
});

describe("the pages", () => {
  test("the business's owner sees who has access, through which agency, until when", async () => {
    await as("rotary-owner", "rotary");
    const rendered = text(await TeamPage({ searchParams: Promise.resolve({}) }));
    expect(rendered).toContain("Agency access");
    expect(rendered).toContain(`agency ${TAG}`);
    expect(rendered).toContain(addr("worker"));
  });

  test("an agency person working in the business does not see the agency section", async () => {
    await as("worker", "rotary");
    const rendered = text(await TeamPage({ searchParams: Promise.resolve({}) }));
    expect(rendered).not.toContain("Agency access");
  });

  test("the agency sees its access and its people; another business gets no Agency page", async () => {
    await as("agency-boss", "agency");
    const rendered = text(await AgencyPage({ searchParams: Promise.resolve({}) }));
    expect(rendered).toContain(`rotary ${TAG}`);
    expect(rendered).toContain(addr("worker"));
    await as("rotary-owner", "rotary");
    await expect(AgencyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect 404");
  });
});

describe("ending", () => {
  test("revoked by the business's manager: gone for everybody on it", async () => {
    const g = await grantFor("rotary");
    await as("rotary-manager", "rotary");
    expect(await act(businessSide.revokeGrantAction, { grantId: g.id })).toBe("/team?agency=revoked");
    expect(await reach("worker")).toEqual([]);
  });

  test("the agency can withdraw a request it no longer needs", async () => {
    await as("agency-boss", "agency");
    expect(await act(agencySide.requestAccessAction, { businessRef: slug.northstar!, reason: "Brochure redesign" })).toBe(
      "/agency?done=asked",
    );
    const g = await grantFor("northstar");
    expect(await act(agencySide.withdrawGrantAction, { grantId: g.id })).toBe("/agency?done=withdrawn");
    expect((await grantFor("northstar")).status).toBe("revoked");
  });

  test("nobody from the agency was ever made a member of either business", async () => {
    const rows = await owner.query(
      "select count(*)::int as n from memberships where organization_id = any($1::uuid[]) and user_id = any($2::uuid[])",
      [[org.rotary, org.northstar], [who["agency-boss"]!.userId, who["agency-editor"]!.userId, who.worker!.userId]],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
