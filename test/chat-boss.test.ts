import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * Chat Boss (/chat), end to end on the server: real sign-in and portal
 * sessions, real memberships, the real central authorization function, server
 * actions and route handlers. Only the browser is stood in for — its cookie
 * and the headers it sends.
 *
 * Who: the people on CHAT_BOSS_EMAILS, and nobody else. Where: the business
 * the session has open, and only one they belong to. How: every write carries
 * the session's CSRF token.
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

const browser = vi.hoisted(() => ({ token: null as string | null, origin: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (browser.token && name.includes("portal_session") ? { name, value: browser.token } : undefined),
    set: () => {},
  }),
  headers: async () => new Headers(browser.origin ? { origin: browser.origin } : {}),
}));

const { resolveIdentity, startSession } = await import("@/lib/auth/session");
const { requireChatBossPage } = await import("@/lib/auth/authorize");
const { appOrigin } = await import("@/lib/auth/origin");
const { closePool } = await import("@/lib/db/connection");
const { workspaceAccess } = await import("@/lib/workspace/access");
const { newConversationAction } = await import("@/app/chat/actions");
const { GET: listRepositories } = await import("@/app/api/workspace/repositories/route");
const { POST: sendMessage } = await import("@/app/api/workspace/conversations/[id]/messages/route");

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `cb${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const orgs: Record<string, string> = {};
const authUsers: string[] = [];
const people: Record<string, { userId: string; token: string }> = {};

async function business(name: string) {
  orgs[name] = (
    await owner.query("insert into organizations (type, name, slug) values ('client', $1, $2) returning id", [
      `${name} ${TAG}`,
      `${TAG}-${name}`,
    ])
  ).rows[0].id;
}

async function signedIn(label: string, memberOf: [string, string][]) {
  const authUserId = `auth-${label}-${TAG}`;
  authUsers.push(authUserId);
  await owner.query("insert into auth_users (id, name, email) values ($1, 'T', $2)", [authUserId, addr(label)]);
  const authSessionId = randomUUID();
  await owner.query(
    `insert into auth_sessions (id, token, user_id, expires_at) values ($1, $2, $3, now() + interval '7 days')`,
    [authSessionId, `token-${authSessionId}`, authUserId],
  );
  await owner.query("update auth_sessions set mfa_verified_at = now() where id = $1", [authSessionId]);
  const userId = (
    await owner.query("insert into users (email, auth_user_id) values ($1, $2) returning id", [addr(label), authUserId])
  ).rows[0].id as string;
  for (const [name, role] of memberOf) {
    await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, $3)", [
      userId,
      orgs[name],
      role,
    ]);
  }
  const { token } = await startSession({ userId, host: "app.test", authSessionId, hardEnd: new Date(Date.now() + 7 * 86_400_000) });
  people[label] = { userId, token };
}

function as(label: string) {
  browser.token = people[label]!.token;
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

async function form(fields: Record<string, string> = {}, opts: { csrf?: boolean } = {}) {
  const f = new FormData();
  const identity = await resolveIdentity();
  if (opts.csrf !== false && identity.state === "active") f.set("csrf", identity.csrfToken);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const conversationsIn = async (org: string) =>
  Number((await owner.query("select count(*)::int as n from conversations where organization_id = $1", [org])).rows[0].n);

beforeAll(async () => {
  await owner.connect();
  await business("alpha");
  await business("bravo");
  await signedIn("boss", [["alpha", "owner"]]);
  await signedIn("plain-owner", [["alpha", "owner"]]);
  await signedIn("boss-two", [["alpha", "owner"], ["bravo", "viewer"]]);
});

afterAll(async () => {
  const ids = Object.values(orgs);
  const emails = `%-${TAG}@test.invalid`;
  await owner.query("delete from conversations where organization_id = any($1::uuid[])", [ids]).catch(() => {});
  await owner.query("delete from workspaces where organization_id = any($1::uuid[])", [ids]).catch(() => {});
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
  process.env.CHAT_BOSS_EMAILS = `${addr("boss")}, ${addr("boss-two").toUpperCase()}`;
  browser.token = null;
  browser.origin = null;
});

describe("who gets Chat Boss", () => {
  test("a person on the list, on the business they have open", async () => {
    as("boss");
    const granted = await requireChatBossPage("/chat");
    expect(granted.businessId).toBe(orgs.alpha);
    const access = await workspaceAccess(granted.ctx);
    expect(access).toMatchObject({
      owner: { organizationId: orgs.alpha, userId: people.boss!.userId },
      scope: { organizationId: orgs.alpha, isStaff: false },
      client: { id: orgs.alpha, isHouse: false },
    });
  });

  test("an owner who is not on the list gets a 404, as for a page that does not exist", async () => {
    as("plain-owner");
    expect(await outcome(() => requireChatBossPage("/chat"))).toBe("404");
  });

  test("the list is the only key: with it empty, nobody", async () => {
    process.env.CHAT_BOSS_EMAILS = "";
    as("boss");
    expect(await outcome(() => requireChatBossPage("/chat"))).toBe("404");
  });

  test("signed out: sent to sign in", async () => {
    expect(await outcome(() => requireChatBossPage("/chat"))).toMatch(/^\/auth\/sso\/start/);
  });

  test("with several businesses and none open: sent to choose one first", async () => {
    as("boss-two");
    expect(await outcome(() => requireChatBossPage("/chat"))).toBe("/business");
  });
});

describe("writes need the token, the list, and the business", () => {
  test("a listed person starts a conversation in their open business", async () => {
    as("boss");
    const before = await conversationsIn(orgs.alpha!);
    expect(await outcome(async () => newConversationAction(await form()))).toMatch(/^\/chat\?c=/);
    expect(await conversationsIn(orgs.alpha!)).toBe(before + 1);
  });

  test("without the CSRF token, or from another origin, nothing is written", async () => {
    as("boss");
    const before = await conversationsIn(orgs.alpha!);
    expect(await outcome(async () => newConversationAction(await form({}, { csrf: false })))).toMatch(/^error: /);
    browser.origin = "https://evil.example";
    expect(await outcome(async () => newConversationAction(await form()))).toMatch(/^error: /);
    expect(await conversationsIn(orgs.alpha!)).toBe(before);
  });

  test("an owner who is not on the list writes nothing", async () => {
    as("plain-owner");
    const before = await conversationsIn(orgs.alpha!);
    expect(await outcome(async () => newConversationAction(await form()))).toBe("404");
    expect(await conversationsIn(orgs.alpha!)).toBe(before);
  });
});

describe("the Chat Boss routes", () => {
  const request = (path: string, init: RequestInit = {}) =>
    new Request(`${appOrigin()}${path}`, { ...init, headers: { origin: appOrigin() ?? "", ...(init.headers ?? {}) } });

  test("not on the list: refused", async () => {
    as("plain-owner");
    expect((await listRepositories(request("/api/workspace/repositories"))).status).toBe(403);
  });

  test("on the list: let through to the route itself", async () => {
    as("boss");
    expect((await listRepositories(request("/api/workspace/repositories"))).status).not.toBe(403);
  });

  test("sending a message without the CSRF header is refused before anything runs", async () => {
    as("boss");
    const res = await sendMessage(
      request(`/api/workspace/conversations/${randomUUID()}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      }),
      { params: Promise.resolve({ id: randomUUID() }) },
    );
    expect(res.status).toBe(403);
  });
});
