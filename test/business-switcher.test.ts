import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { activeBusiness } from "@/lib/auth/policy";

/**
 * The business switcher, end to end on the server: a real sign-in session on
 * the login side, a real portal session started from it, real memberships,
 * and the real session resolution, authorization function and server action.
 * Only the browser is stood in for — the cookie it holds and the headers it
 * sends.
 */

// The portal's own origin, which every state-changing request must carry.
// CI configures no host; the value only has to agree with itself.
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
const { requirePage } = await import("@/lib/auth/authorize");
const { appOrigin } = await import("@/lib/auth/origin");
const { closePool } = await import("@/lib/db/connection");
const { switchBusinessAction } = await import("@/app/business/actions");
const { default: BusinessPage } = await import("@/app/business/page");

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `bs${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const orgs: Record<string, string> = {};
const authUsers: string[] = [];

async function business(name: string, type: "client" | "internal" = "client") {
  orgs[name] = (
    await owner.query("insert into organizations (type, name, slug) values ($1, $2, $3) returning id", [
      type,
      `${name} ${TAG}`,
      `${TAG}-${name}`,
    ])
  ).rows[0].id;
  return orgs[name];
}

/** A person bound to a sign-in identity, signed in past the authenticator, with a portal session. */
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
  const { token } = await startSession({
    userId,
    host: "app.test",
    authSessionId,
    hardEnd: new Date(Date.now() + 7 * 86_400_000),
  });
  return { userId, token };
}

async function onScreen() {
  const identity = await resolveIdentity();
  if (identity.state !== "active") return "signed out";
  return identity.ctx.scope.organizationId;
}

/** Post the switch form as the signed-in browser would, with its CSRF token. */
async function switchTo(organizationId: string, opts: { csrf?: string; origin?: string | null } = {}) {
  const identity = await resolveIdentity();
  const f = new FormData();
  f.set("csrf", opts.csrf ?? (identity.state === "active" ? identity.csrfToken : ""));
  f.set("organizationId", organizationId);
  browser.origin = opts.origin === undefined ? appOrigin() : opts.origin;
  try {
    await switchBusinessAction(f);
    return "returned";
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    return `error: ${(e as Error).message}`;
  }
}

async function pageFor(action: Parameters<typeof requirePage>[0]) {
  try {
    const granted = await requirePage(action, { returnPath: "/jobs" });
    return granted.businessId;
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
}

/** Every string rendered anywhere in a server component's element tree. */
function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  const props = (node as { props?: Record<string, unknown> }).props;
  return props ? Object.values(props).map(text).join(" ") : "";
}

beforeAll(async () => {
  await owner.connect();
  await business("alpha");
  await business("bravo");
  await business("charlie");
  await business("closed");
  await business("house", "internal");
  await owner.query("update organizations set deleted_at = now() where id = $1", [orgs.closed]);
});

afterAll(async () => {
  const ids = Object.values(orgs);
  const emails = `%-${TAG}@test.invalid`;
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

describe("which business is on screen (the rule)", () => {
  test("the chosen one while still a member; else the only one; else none", () => {
    expect(activeBusiness(["a", "b"], "b")).toBe("b");
    expect(activeBusiness(["a", "b"], null)).toBeNull();
    expect(activeBusiness(["a", "b"], "c")).toBeNull();
    expect(activeBusiness(["a"], null)).toBe("a");
    expect(activeBusiness(["a"], "c")).toBe("a");
    expect(activeBusiness([], "c")).toBeNull();
    expect(activeBusiness([], null)).toBeNull();
  });
});

describe("somebody with several businesses", () => {
  let person: { userId: string; token: string };

  beforeAll(async () => {
    person = await signedIn("multi", [
      ["alpha", "owner"],
      ["bravo", "viewer"],
      ["closed", "owner"],
      ["house", "staff"],
    ]);
  });

  test("starts with none open, and every page sends them to choose", async () => {
    browser.token = person.token;
    expect(await onScreen()).toBeNull();
    expect(await pageFor("jobs.read")).toBe("/business");
  });

  test("the chooser lists their client businesses and their role, and not the house or a closed one", async () => {
    browser.token = person.token;
    const rendered = text(await BusinessPage({ searchParams: Promise.resolve({}) }));
    expect(rendered).toContain(`alpha ${TAG}`);
    expect(rendered).toContain(`bravo ${TAG}`);
    expect(rendered).toContain("Owner");
    expect(rendered).toContain("Viewer");
    expect(rendered).not.toContain(`house ${TAG}`);
    expect(rendered).not.toContain(`closed ${TAG}`);
    expect(rendered).not.toContain(`charlie ${TAG}`);
  });

  test("opening one: it is on screen, and the role there is what counts", async () => {
    browser.token = person.token;
    expect(await switchTo(orgs.alpha)).toBe("/dashboard");
    expect(await onScreen()).toBe(orgs.alpha);
    expect(await pageFor("staff.manage")).toBe(orgs.alpha);

    expect(await switchTo(orgs.bravo)).toBe("/dashboard");
    expect(await onScreen()).toBe(orgs.bravo);
    expect(await pageFor("jobs.read")).toBe(orgs.bravo);
    // A viewer in bravo, whatever they are in alpha.
    expect(await pageFor("staff.manage")).toBe("/access?reason=role_lacks_action");
  });

  test("a business they are not in, a closed one, or the house cannot be opened", async () => {
    browser.token = person.token;
    for (const name of ["charlie", "closed", "house"]) {
      expect(await switchTo(orgs[name]), name).toBe("/business?error=not_yours");
    }
    expect(await switchTo("not-a-uuid")).toBe("/business?error=not_yours");
    expect(await onScreen()).toBe(orgs.bravo);
  });

  test("a forged switch is refused: another origin, no origin, or no CSRF token", async () => {
    browser.token = person.token;
    expect(await switchTo(orgs.alpha, { origin: "https://evil.test" })).toMatch(/^error: /);
    expect(await switchTo(orgs.alpha, { origin: null })).toMatch(/^error: /);
    expect(await switchTo(orgs.alpha, { csrf: "forged" })).toMatch(/^error: /);
    expect(await onScreen()).toBe(orgs.bravo);
  });

  test("removed from the business on screen: it is gone on the next request", async () => {
    browser.token = person.token;
    expect(await onScreen()).toBe(orgs.bravo);
    await owner.query("delete from memberships where user_id = $1 and organization_id = $2", [
      person.userId,
      orgs.bravo,
    ]);
    // Alpha is now their only client business, so it opens by itself.
    expect(await onScreen()).toBe(orgs.alpha);
  });
});

describe("somebody with one business, or none", () => {
  test("one: it is simply open, no choosing", async () => {
    const solo = await signedIn("solo", [["charlie", "editor"]]);
    browser.token = solo.token;
    expect(await onScreen()).toBe(orgs.charlie);
    expect(await pageFor("jobs.read")).toBe(orgs.charlie);
  });

  test("none: sent to the chooser, which says so", async () => {
    const none = await signedIn("none", [["house", "member"]]);
    browser.token = none.token;
    expect(await pageFor("jobs.read")).toBe("/business");
    const rendered = text(await BusinessPage({ searchParams: Promise.resolve({}) }));
    expect(rendered).toContain("isn't attached to any business yet");
  });

  test("signed out: the chooser sends you to sign in", async () => {
    try {
      await BusinessPage({ searchParams: Promise.resolve({}) });
      throw new Error("rendered");
    } catch (e) {
      expect((e as Redirect).to).toMatch(/^\/auth\/sso\/start\?path=%2Fbusiness/);
    }
  });
});
