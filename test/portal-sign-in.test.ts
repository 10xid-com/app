import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

/**
 * Signing in on the portal itself, end to end through the server actions, as
 * the restricted role: the address, the emailed code, then the authenticator
 * every time — and that nothing short of all of it opens a page.
 */

process.env.PORTAL_HOST ||= "app.portal.test";
process.env.SESSION_COOKIE_SECURE = "false";
process.env.TOTP_ENC_KEY = randomBytes(32).toString("base64");

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

const mail = vi.hoisted(() => ({ codes: [] as { to: string; code: string }[] }));
vi.mock("@/lib/auth/mailer", () => ({
  sendSignInCode: vi.fn(async (input: { to: string; code: string }) => {
    mail.codes.push({ to: input.to, code: input.code });
  }),
}));

/** One browser: its cookie jar, and the Origin its forms post with. */
const browser = vi.hoisted(() => ({ jar: new Map<string, string>(), origin: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (browser.jar.has(name) ? { name, value: browser.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0 || value === "") browser.jar.delete(name);
      else browser.jar.set(name, value);
    },
  }),
  headers: async () => new Headers({ ...(browser.origin ? { origin: browser.origin } : {}), host: "app.portal.test" }),
}));

const actions = await import("@/app/auth/actions");
const { signOutAction } = await import("@/app/sign-out");
const { resolveIdentity } = await import("@/lib/auth/session");
const { requirePage } = await import("@/lib/auth/authorize");
const { appOrigin } = await import("@/lib/auth/origin");
const { CSRF_FIELD } = await import("@/lib/auth/csrf");
const { currentCode, decryptSecret } = await import("@/lib/auth/totp");
const { RECOVERY_FLASH_COOKIE } = await import("@/lib/auth/recovery");
const { closePool } = await import("@/lib/db/connection");

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `ps${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
let business = "";
let inviter = "";

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "returned";
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    return `error: ${(e as Error).message}`;
  }
}

/** Post a form as this browser would: its Origin, and the CSRF token of whatever session it holds. */
async function post(action: (f: FormData) => Promise<unknown>, fields: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  const identity = await resolveIdentity();
  if (identity.state !== "signed_out") f.set(CSRF_FIELD, identity.csrfToken);
  return outcome(() => action(f));
}

const lastCodeFor = (email: string) => mail.codes.filter((c) => c.to === email).at(-1)?.code;

async function secretOf(email: string): Promise<string> {
  const { rows } = await owner.query("select totp_secret from users where email = $1", [email]);
  return decryptSecret(rows[0].totp_secret);
}

/** The emailed-code half: address, then code. Leaves a pending session. */
async function emailStep(email: string, next = "/dashboard") {
  expect(await post(actions.requestCodeAction, { email, next })).toBe(
    `/auth/verify?${new URLSearchParams({ email, next })}`,
  );
  return post(actions.verifyCodeAction, { email, next, code: lastCodeFor(email) ?? "000000" });
}

async function invite(email: string) {
  await owner.query(
    "insert into invitations (organization_id, email, role, invited_by, expires_at) values ($1, $2, 'owner', $3, now() + interval '7 days')",
    [business, email, inviter],
  );
}

beforeAll(async () => {
  await owner.connect();
  business = (
    await owner.query("insert into organizations (type, name, slug) values ('client', $1, $2) returning id", [`Biz ${TAG}`, `${TAG}-biz`])
  ).rows[0].id;
  inviter = (await owner.query("insert into users (email) values ($1) returning id", [addr("inviter")])).rows[0].id;
});

beforeEach(() => {
  browser.jar.clear();
  browser.origin = appOrigin();
});

afterAll(async () => {
  await owner.end();
  await closePool();
});

describe("the first sign-in, from an invitation", () => {
  const email = addr("new");

  test("the emailed code makes a pending session that opens nothing", async () => {
    await invite(email);
    expect(await emailStep(email)).toBe("/auth/authenticator?next=%2Fdashboard");
    expect((await resolveIdentity()).state).toBe("pending");
    // A page treats it as signed out, and sign-in sends it on to the authenticator.
    expect(await outcome(() => requirePage("jobs.read", { returnPath: "/jobs" }))).toBe("/auth/sign-in?next=%2Fjobs");
    const { rows } = await owner.query(
      "select m.role from users u join memberships m on m.user_id = u.id where u.email = $1 and m.organization_id = $2",
      [email, business],
    );
    expect(rows).toEqual([{ role: "owner" }]);
  });

  test("setting up the authenticator finishes signing in and shows recovery codes once", async () => {
    await emailStep(email);
    expect(await post(actions.beginEnrolmentAction, { next: "/dashboard" })).toBe(
      "/auth/authenticator?next=%2Fdashboard&step=scan",
    );
    const pendingToken = browser.jar.get("portal_session");
    expect(await post(actions.confirmEnrolmentAction, { next: "/dashboard", code: "000001" })).toContain("error=invalid");

    const code = currentCode(await secretOf(email));
    expect(await post(actions.confirmEnrolmentAction, { next: "/dashboard", code })).toBe(
      "/auth/recovery-codes?next=%2Fdashboard",
    );
    const identity = await resolveIdentity();
    expect(identity.state).toBe("active");
    // A new token: the one from before the authenticator carries no authority.
    expect(browser.jar.get("portal_session")).not.toBe(pendingToken);
    expect(browser.jar.get(RECOVERY_FLASH_COOKIE)?.split(" ")).toHaveLength(10);
    const granted = await requirePage("jobs.read", { returnPath: "/jobs" });
    expect(granted.businessId).toBe(business);
  });
});

describe("every later sign-in", () => {
  const email = addr("back");
  let recovery: string[] = [];

  beforeAll(async () => {
    await invite(email);
    browser.jar.clear();
    browser.origin = appOrigin();
    await emailStep(email);
    await post(actions.beginEnrolmentAction, { next: "/" });
    await post(actions.confirmEnrolmentAction, { next: "/", code: currentCode(await secretOf(email)) });
    recovery = browser.jar.get(RECOVERY_FLASH_COOKIE)!.split(" ");
  });

  test("the emailed code is never enough: the authenticator is asked for", async () => {
    expect(await emailStep(email)).toBe("/auth/authenticator?next=%2Fdashboard");
    expect((await resolveIdentity()).state).toBe("pending");
    // Setting up again is refused while one is confirmed: the inbox cannot replace it.
    expect(await post(actions.beginEnrolmentAction, { next: "/dashboard" })).toBe("/auth/authenticator?next=%2Fdashboard");
    expect(await post(actions.authenticatorAction, { next: "/dashboard", code: "123456" })).toContain("error=invalid");
    expect((await resolveIdentity()).state).toBe("pending");

    expect(await post(actions.authenticatorAction, { next: "/dashboard", code: currentCode(await secretOf(email)) })).toBe(
      "/dashboard",
    );
    expect((await resolveIdentity()).state).toBe("active");
  });

  test("a recovery code works in its place, once", async () => {
    await emailStep(email);
    expect(await post(actions.authenticatorAction, { next: "/", code: recovery[0] })).toBe("/");
    expect((await resolveIdentity()).state).toBe("active");
    browser.jar.clear();
    await emailStep(email);
    expect(await post(actions.authenticatorAction, { next: "/", code: recovery[0] })).toContain("error=invalid");
  });

  test("too many wrong codes, and the account stops accepting any for a while", async () => {
    const other = addr("guessed");
    await invite(other);
    await emailStep(other);
    await post(actions.beginEnrolmentAction, { next: "/" });
    await post(actions.confirmEnrolmentAction, { next: "/", code: currentCode(await secretOf(other)) });
    browser.jar.clear();
    await emailStep(other);
    // Ten wrong guesses, counting the earlier ones.
    const { rows } = await owner.query("select id from users where email = $1", [other]);
    const before = await owner.query("select count(*)::int as n from sign_in_codes where email = $1", [`authenticator:${rows[0].id}`]);
    for (let i = before.rows[0].n; i < 10; i++) await post(actions.authenticatorAction, { next: "/", code: "000000" });
    expect(await post(actions.authenticatorAction, { next: "/", code: currentCode(await secretOf(other)) })).toContain(
      "error=too_many_attempts",
    );
  });

  test("signing out ends the session", async () => {
    await emailStep(email);
    await post(actions.authenticatorAction, { next: "/", code: currentCode(await secretOf(email)) });
    expect(await post(signOutAction)).toBe("/auth/sign-in?notice=signed-out");
    expect((await resolveIdentity()).state).toBe("signed_out");
  });
});

describe("a password, set on the security page, in place of the emailed code", () => {
  const email = addr("pw");
  const PASSWORD = "correct horse battery";

  /** Signed in fully with the emailed code and the authenticator. */
  async function signIn() {
    await emailStep(email);
    await post(actions.authenticatorAction, { next: "/", code: currentCode(await secretOf(email)) });
    expect((await resolveIdentity()).state).toBe("active");
  }

  beforeAll(async () => {
    await invite(email);
    browser.jar.clear();
    browser.origin = appOrigin();
    await emailStep(email);
    await post(actions.beginEnrolmentAction, { next: "/" });
    await post(actions.confirmEnrolmentAction, { next: "/", code: currentCode(await secretOf(email)) });
  });

  test("setting one needs the authenticator within five minutes, and a sound password", async () => {
    await signIn();
    const identity = await resolveIdentity();
    if (identity.state !== "active") throw new Error("not signed in");
    await owner.query("update sessions set second_factor_at = now() - interval '10 minutes' where id = $1", [identity.sessionId]);
    expect(await post(actions.setPasswordAction, { password: PASSWORD, confirm: PASSWORD })).toBe(
      "/auth/confirm?next=%2Fauth%2Fsecurity",
    );
    await owner.query("update sessions set second_factor_at = now() where id = $1", [identity.sessionId]);
    expect(await post(actions.setPasswordAction, { password: "short", confirm: "short" })).toContain("error=password_short");
    expect(await post(actions.setPasswordAction, { password: PASSWORD, confirm: `${PASSWORD}!` })).toContain(
      "error=password_mismatch",
    );
    expect(await post(actions.setPasswordAction, { password: PASSWORD, confirm: PASSWORD })).toBe("/auth/security?done=password");
    const { rows } = await owner.query("select password_hash from users where email = $1", [email]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  test("the password is a first step only: the authenticator is still asked for", async () => {
    browser.jar.clear();
    expect(await post(actions.passwordSignInAction, { email, password: PASSWORD, next: "/jobs" })).toBe(
      "/auth/authenticator?next=%2Fjobs",
    );
    expect((await resolveIdentity()).state).toBe("pending");
    expect(await post(actions.authenticatorAction, { next: "/jobs", code: currentCode(await secretOf(email)) })).toBe("/jobs");
    expect((await resolveIdentity()).state).toBe("active");
  });

  test("a wrong password, an unknown address and an account with no password all answer the same", async () => {
    browser.jar.clear();
    const wrong = await post(actions.passwordSignInAction, { email, password: "not the password", next: "/" });
    const unknown = await post(actions.passwordSignInAction, { email: addr("nobody-pw"), password: PASSWORD, next: "/" });
    expect(wrong).toContain("error=password");
    expect(unknown).toContain("error=password");
    expect(wrong.replace(/email=[^&]*/, "")).toBe(unknown.replace(/email=[^&]*/, ""));
    expect((await resolveIdentity()).state).toBe("signed_out");
  });

  test("an account with no authenticator cannot use a password, even a right one", async () => {
    const other = addr("pw-noauth");
    const { rows } = await owner.query("insert into users (email) values ($1) returning id", [other]);
    const { hashPassword } = await import("@/lib/auth/password");
    await owner.query("update users set password_hash = $2 where id = $1", [rows[0].id, await hashPassword(PASSWORD)]);
    browser.jar.clear();
    expect(await post(actions.passwordSignInAction, { email: other, password: PASSWORD, next: "/" })).toContain("error=password");
    expect((await resolveIdentity()).state).toBe("signed_out");
  });

  test("too many wrong passwords, and the address stops accepting any for a while", async () => {
    const target = addr("pw-guessed");
    browser.jar.clear();
    for (let i = 0; i < 10; i++) await post(actions.passwordSignInAction, { email: target, password: `guess ${i} guess`, next: "/" });
    expect(await post(actions.passwordSignInAction, { email: target, password: PASSWORD, next: "/" })).toContain(
      "error=password_rate",
    );
  });

  test("removed, and the password no longer works", async () => {
    browser.jar.clear();
    await signIn();
    expect(await post(actions.removePasswordAction)).toBe("/auth/security?done=password_removed");
    browser.jar.clear();
    expect(await post(actions.passwordSignInAction, { email, password: PASSWORD, next: "/" })).toContain("error=password");
  });
});

describe("what never gets a session", () => {
  test("an address with no account and no invitation: the same answer, and no email", async () => {
    const email = addr("nobody");
    expect(await post(actions.requestCodeAction, { email, next: "/" })).toContain("/auth/verify");
    expect(lastCodeFor(email)).toBeUndefined();
    expect(await post(actions.verifyCodeAction, { email, next: "/", code: "123456" })).toContain("error=invalid");
    expect((await resolveIdentity()).state).toBe("signed_out");
  });

  test("a service account", async () => {
    const email = addr("service");
    await owner.query("insert into users (email, is_service) values ($1, true)", [email]);
    await post(actions.requestCodeAction, { email, next: "/" });
    expect(lastCodeFor(email)).toBeUndefined();
    expect((await resolveIdentity()).state).toBe("signed_out");
  });

  test("a form posted from anywhere but the portal", async () => {
    browser.origin = "https://login.10xid.com";
    expect(await post(actions.requestCodeAction, { email: addr("x"), next: "/" })).toMatch(/did not come from the portal/);
  });

  test("a session handed over from login.10xid.com", async () => {
    const email = addr("handed");
    const { rows } = await owner.query("insert into users (email) values ($1) returning id", [email]);
    const token = randomBytes(32).toString("base64url");
    const { createHash } = await import("node:crypto");
    await owner.query(
      `insert into sessions (user_id, token_hash, issued_for_host, idle_seconds, absolute_expires_at, role_at_creation, second_factor_at, source_auth_session_id)
       values ($1, $2, 'app.portal.test', 172800, now() + interval '7 days', 'client', now(), 'auth-session-from-login')`,
      [rows[0].id, createHash("sha256").update(token).digest()],
    );
    browser.jar.set("portal_session", token);
    expect((await resolveIdentity()).state).toBe("signed_out");
  });
});
