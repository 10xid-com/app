import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

/**
 * Agency-grant expiry reminders, against the real database (login's 0026):
 * who is due, that each person is told once however the run is started, what
 * a delivery failure does, the scheduler's endpoint, renewal by a fresh
 * approval, and the link in the email.
 */

process.env.PORTAL_HOST ||= "app.portal.test";
process.env.PRIMARY_HOST ||= "login.portal.test";
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

// Resend, for the one test that makes it refuse a message.
const resend = vi.hoisted(() => ({ error: null as { message: string } | null, sent: [] as string[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (m: { to: string }) => {
        resend.sent.push(m.to);
        return resend.error ? { data: null, error: resend.error } : { data: { id: "x" }, error: null };
      },
    };
  },
}));

const { resolveIdentity, startSession } = await import("@/lib/auth/session");
const { appOrigin } = await import("@/lib/auth/origin");
const { closePool } = await import("@/lib/db/connection");
const { setSessionActiveOrganization } = await import("@/lib/db/identity");
const { dueExpiryReminders, claimReminder, recordReminder } = await import("@/lib/db/agency-reminders");
const { runExpiryReminders, reminderEmail, sendTestReminder } = await import("@/lib/agency/reminders");
const { sendExpiryReminder } = await import("@/lib/auth/mailer");
const { POST: cronPost } = await import("@/app/api/v1/cron/agency-reminders/route");
const agencySide = await import("@/app/agency/actions");
const businessSide = await import("@/app/team/agency-actions");
const { switchBusinessAction } = await import("@/app/business/actions");
const { default: GrantPage } = await import("@/app/grants/[id]/page");
const { default: TeamPage } = await import("@/app/team/page");

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `rm${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const org: Record<string, string> = {};
const who: Record<string, { userId: string; token: string; sessionId: string }> = {};
const grant: Record<string, string> = {};
const authUsers: string[] = [];

async function organization(key: string) {
  org[key] = (
    await owner.query("insert into organizations (type, name, slug) values ('client', $1, $2) returning id", [
      `${key} ${TAG}`,
      `${TAG}-${key}`,
    ])
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
  // A sign-in starts before the authenticator (the insert clears this), then passes it.
  await owner.query("update auth_sessions set mfa_verified_at = now() where id = $1", [authSessionId]);
  const userId = (await owner.query("insert into users (email, auth_user_id) values ($1, $2) returning id", [addr(key), authUserId])).rows[0]
    .id as string;
  for (const [o, role] of memberOf) {
    await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, $3)", [userId, org[o], role]);
  }
  const { token, sessionId } = await startSession({ userId, host: "app.test", authSessionId, hardEnd: new Date(Date.now() + 7 * 86_400_000) });
  who[key] = { userId, token, sessionId };
}

/** A grant from the agency to `client`, approved, ending `ends` from now (an interval, may be negative). */
async function grantEnding(key: string, client: string, ends: string) {
  const id = (
    await owner.query(
      `insert into agency_grants (client_organization_id, agency_organization_id, reason, duration_days, requested_by)
       values ($1, $2, 'Website and print work', 30, $3) returning id`,
      [org[client], org.agency, who["agency-owner"]!.userId],
    )
  ).rows[0].id as string;
  await owner.query("update agency_grants set status = 'active', decided_by = $2, expires_at = now() + interval '30 days' where id = $1", [
    id,
    who["client-owner"]!.userId,
  ]);
  await owner.query("update agency_grants set expires_at = now() + $2::interval where id = $1", [id, ends]);
  grant[key] = id;
  return id;
}

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
    if (e instanceof Redirect) return e.to;
    return `error: ${(e as Error).message}`;
  }
}

/** Every string rendered anywhere in a server component's element tree. */
function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  const el = node as { props?: Record<string, unknown>; type?: unknown };
  if (typeof el.type === "function" && el.type.constructor.name !== "AsyncFunction") {
    return text((el.type as (p: unknown) => unknown)(el.props));
  }
  return el.props ? Object.values(el.props).map(text).join(" ") : "";
}

async function render(fn: () => Promise<unknown>) {
  try {
    return { rendered: text(await fn()).replace(/\s+/g, " ") };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    throw e;
  }
}

/** The run, over this file's grants only (the database is shared with other suites). */
type Sent = { to: string; subject: string; text: string };
function run(send: (m: Sent) => Promise<void>) {
  const mine = new Set(Object.values(grant));
  return runExpiryReminders({
    due: async () => (await dueExpiryReminders()).filter((d) => mine.has(d.grantId)),
    claim: claimReminder,
    record: recordReminder,
    send,
  });
}
const collect = () => {
  const out: Sent[] = [];
  return { out, send: async (m: Sent) => void out.push(m) };
};
const reminders = async (grantId: string) =>
  (
    await owner.query(
      `select u.email, r.status, r.attempts, r.last_error from agency_grant_reminders r join users u on u.id = r.user_id
        where r.grant_id = $1 order by u.email`,
      [grantId],
    )
  ).rows;
const forget = (grantId: string) => owner.query("delete from agency_grant_reminders where grant_id = $1", [grantId]);
const reach = async (key: string) => {
  browser.token = who[key]!.token;
  const identity = await resolveIdentity();
  return identity.state === "active" ? identity.ctx.agencyAccess.map((a) => a.organizationId) : [];
};

beforeAll(async () => {
  await owner.connect();
  for (const k of ["agency", "due", "later", "ended", "revoked", "asked", "renewed", "gone", "elsewhere"]) await organization(k);
  await owner.query("update organizations set is_agency = true where id = $1", [org.agency]);
  await person("agency-owner", [["agency", "owner"]]);
  await person("agency-owner2", [["agency", "owner"]]);
  await person("worker", [["agency", "viewer"]]);
  const clients: [string, string][] = ["due", "later", "ended", "revoked", "asked", "renewed", "gone"].map((c) => [c, "owner"]);
  await person("client-owner", clients);
  await person("client-owner2", [["due", "owner"]]);
  await person("client-manager", [["due", "manager"]]);
  await person("outsider", [["elsewhere", "owner"]]);

  await grantEnding("due", "due", "6 days");
  await grantEnding("later", "later", "8 days");
  await grantEnding("ended", "ended", "-1 hour");
  await grantEnding("revoked", "revoked", "6 days");
  await owner.query("update agency_grants set status = 'revoked', revoked_by = $2 where id = $1", [grant.revoked, who["client-owner"]!.userId]);
  grant.asked = (
    await owner.query(
      `insert into agency_grants (client_organization_id, agency_organization_id, reason, requested_by)
       values ($1, $2, 'Website and print work', $3) returning id`,
      [org.asked, org.agency, who["agency-owner"]!.userId],
    )
  ).rows[0].id;
  await grantEnding("renewed", "renewed", "6 days");
  await grantEnding("gone", "gone", "6 days");
  await owner.query("update organizations set deleted_at = now() where id = $1", [org.gone]);
});

afterAll(async () => {
  const ids = Object.values(org);
  const emails = `%-${TAG}@test.invalid`;
  const grants = "select id from agency_grants where client_organization_id = any($1::uuid[])";
  await owner.query(`delete from agency_grant_reminders where grant_id in (${grants})`, [ids]);
  await owner.query("delete from audit_events where organization_id = any($1::uuid[])", [ids]);
  await owner.query(`delete from agency_grant_people where grant_id in (${grants})`, [ids]);
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
  resend.error = null;
  resend.sent = [];
});

describe("who is due", () => {
  test("in force and ending within seven days: not later, not ended, not revoked, not a request, not a gone business", async () => {
    const mine = new Set(Object.values(grant));
    const due = (await dueExpiryReminders()).filter((d) => mine.has(d.grantId));
    expect(due.map((d) => d.grantId).sort()).toEqual([grant.due, grant.renewed].sort());
  });

  test("the owners of each side, and only the owners", async () => {
    const due = (await dueExpiryReminders()).find((d) => d.grantId === grant.due)!;
    expect(due.recipients.map((r) => `${r.side}:${r.email}`).sort()).toEqual(
      [
        `agency:${addr("agency-owner")}`,
        `agency:${addr("agency-owner2")}`,
        `client:${addr("client-owner")}`,
        `client:${addr("client-owner2")}`,
      ].sort(),
    );
  });
});

describe("the email", () => {
  test("the end date and a link to the grant, worded for each side", async () => {
    const due = (await dueExpiryReminders()).find((d) => d.grantId === grant.due)!;
    const date = due.expiresAt.toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "long", timeStyle: "short" });
    const link = `${appOrigin()}/grants/${grant.due}`;
    const client = reminderEmail(due, "client");
    expect(client.subject).toBe(`agency ${TAG}'s access to due ${TAG} ends on ${date} UTC`);
    expect(client.text).toContain(`It ends on ${date} UTC.`);
    expect(client.text).toContain("Nothing renews by itself");
    expect(client.text).toContain(link);
    const agency = reminderEmail(due, "agency");
    expect(agency.subject).toBe(`Your access to due ${TAG} ends on ${date} UTC`);
    expect(agency.text).toContain("ask to renew");
    expect(agency.text).toContain("must approve the renewal, and each of your people again");
    expect(agency.text).toContain(link);
  });
});

describe("once each", () => {
  test("the run tells each owner once, and records it on each side's audit record", async () => {
    const { out, send } = collect();
    // due: two owners on each side; renewed: one client owner, two agency owners.
    expect(await run(send)).toMatchObject({ due: 2, sent: 7, failed: 0, skipped: 0 });
    expect(out.filter((m) => m.text.includes(grant.due!)).map((m) => m.to).sort()).toEqual(
      [addr("agency-owner"), addr("agency-owner2"), addr("client-owner"), addr("client-owner2")].sort(),
    );
    expect((await reminders(grant.due!)).every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
    const audit = await owner.query(
      "select organization_id, count(*)::int as n from audit_events where agency_grant_id = $1 and action = 'agency.grant.expiry_reminded' group by 1",
      [grant.due],
    );
    expect(Object.fromEntries(audit.rows.map((r) => [r.organization_id, r.n]))).toEqual({ [org.due!]: 2, [org.agency!]: 2 });
  });

  test("run again: nobody is told twice", async () => {
    const { out, send } = collect();
    expect(await run(send)).toMatchObject({ sent: 0, skipped: 7 });
    expect(out).toHaveLength(0);
  });

  test("two runs at once: still once each", async () => {
    await forget(grant.due!);
    await forget(grant.renewed!);
    const { out, send } = collect();
    const slow = async (m: Sent) => {
      await new Promise((r) => setTimeout(r, 20));
      await send(m);
    };
    const [a, b] = await Promise.all([run(slow), run(slow)]);
    expect(a.sent + b.sent).toBe(7);
    expect(a.skipped + b.skipped).toBe(7);
    expect(out).toHaveLength(7);
    expect(out.map((m) => `${m.to}|${m.subject}`).sort()).toEqual([...new Set(out.map((m) => `${m.to}|${m.subject}`))].sort());
  });
});

describe("delivery failures", () => {
  test("one failure is recorded, the rest still go, and the report names the grant, not the address", async () => {
    await forget(grant.due!);
    await forget(grant.renewed!);
    const { send } = collect();
    const flaky = async (m: Sent) => {
      if (m.to === addr("agency-owner2")) throw new Error("mail provider timed out");
      await send(m);
    };
    const result = await run(flaky);
    expect(result).toMatchObject({ sent: 5, failed: 2 });
    expect(result.errors.join(" ")).not.toContain("@");
    expect(result.errors.join(" ")).toContain(grant.due!);
    const failed = (await reminders(grant.due!)).find((r) => r.email === addr("agency-owner2"));
    expect(failed).toMatchObject({ status: "failed", attempts: 1, last_error: "mail provider timed out" });
  });

  test("the next run retries only what failed", async () => {
    const { out, send } = collect();
    expect(await run(send)).toMatchObject({ sent: 2, failed: 0, skipped: 5 });
    expect(out.map((m) => m.to)).toEqual([addr("agency-owner2"), addr("agency-owner2")]);
    expect((await reminders(grant.due!)).find((r) => r.email === addr("agency-owner2"))).toMatchObject({ status: "sent", attempts: 2 });
  });

  test("a failure is tried five times in all, then left alone", async () => {
    await forget(grant.due!);
    const failing = async (m: Sent) => {
      if (m.to === addr("agency-owner2")) throw new Error("mailbox unavailable");
    };
    for (let i = 0; i < 5; i++) await run(failing);
    expect((await reminders(grant.due!)).find((r) => r.email === addr("agency-owner2"))).toMatchObject({ status: "failed", attempts: 5 });
    const { out, send } = collect();
    await run(send);
    expect(out.filter((m) => m.to === addr("agency-owner2") && m.text.includes(grant.due!))).toHaveLength(0);
  });

  test("a claim left mid-send (the run died) is not sent again: it may have gone", async () => {
    await forget(grant.due!);
    expect(await claimReminder(grant.due!, who["client-owner"]!.userId)).toBeTruthy();
    const { out, send } = collect();
    await run(send);
    expect(out.filter((m) => m.to === addr("client-owner") && m.text.includes(grant.due!))).toHaveLength(0);
    expect((await reminders(grant.due!)).find((r) => r.email === addr("client-owner"))).toMatchObject({ status: "sending" });
  });

  test("a test send reports a refusal rather than hiding it", async () => {
    const result = await sendTestReminder("bounced@resend.dev", async () => {
      throw new Error("The domain is not verified");
    });
    expect(result).toEqual({ sent: 0, failed: 2, errors: ["The domain is not verified", "The domain is not verified"] });
    await expect(sendTestReminder("someone@example.com")).rejects.toThrow(/resend\.dev/);
  });

  test("a message the mail provider refuses is a failure, not a quiet success", async () => {
    const before = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_test_key";
    try {
      resend.error = { message: "The domain is not verified" };
      await expect(sendExpiryReminder({ to: addr("x"), subject: "s", text: "t" })).rejects.toThrow(/domain is not verified/);
      resend.error = null;
      await expect(sendExpiryReminder({ to: addr("x"), subject: "s", text: "t" })).resolves.toBeUndefined();
      expect(resend.sent).toEqual([addr("x"), addr("x")]);
    } finally {
      if (before === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = before;
    }
  });
});

describe("the scheduler's endpoint", () => {
  const call = (auth?: string) =>
    cronPost(
      new Request("http://app.portal.test/api/v1/cron/agency-reminders", {
        method: "POST",
        headers: auth ? { authorization: auth } : {},
      }),
    );

  test("off until CRON_SECRET is set; then only with it", async () => {
    const before = process.env.CRON_SECRET;
    await forget(grant.due!);
    try {
      delete process.env.CRON_SECRET;
      expect((await call("Bearer anything")).status).toBe(404);
      process.env.CRON_SECRET = "too-short";
      expect((await call("Bearer too-short")).status).toBe(404);
      process.env.CRON_SECRET = "s".repeat(40);
      expect((await call()).status).toBe(401);
      expect((await call(`Bearer ${"t".repeat(40)}`)).status).toBe(401);
      expect((await call(`Basic ${"s".repeat(40)}`)).status).toBe(401);
      const ok = await call(`Bearer ${"s".repeat(40)}`);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(Object.keys(body).sort()).toEqual(["due", "failed", "sent", "skipped"]);
      // Delivered through the mailer (the dev sink here), never answered with an address.
      expect(JSON.stringify(body)).not.toContain("@");
      const sink = await readFile(SINK, "utf8").catch(() => "");
      expect(sink).toContain(`${addr("client-owner")}\tREMINDER\t`);

      // A test send: Resend's test inboxes only, both wordings, nothing run.
      const test = (q: string) =>
        cronPost(
          new Request(`http://app.portal.test/api/v1/cron/agency-reminders?test=${encodeURIComponent(q)}`, {
            method: "POST",
            headers: { authorization: `Bearer ${"s".repeat(40)}` },
          }),
        );
      expect((await test(addr("client-owner"))).status).toBe(400);
      expect((await test("delivered@resend.dev.evil.example")).status).toBe(400);
      const sent = await test("delivered@resend.dev");
      expect(sent.status).toBe(200);
      expect(await sent.json()).toEqual({ test: { sent: 2, failed: 0, errors: [] } });
      expect(await readFile(SINK, "utf8")).toContain("delivered@resend.dev\tREMINDER\t[Test] Test agency's access to Test business ends on");
      process.env.CRON_SECRET = "";
      expect((await test("delivered@resend.dev")).status).toBe(404);
    } finally {
      if (before === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = before;
    }
  });
});

describe("renewal needs the business's owner again", () => {
  test("not while more than seven days remain", async () => {
    await as("agency-owner", "agency");
    expect(await act(agencySide.renewGrantAction, { grantId: grant.later! })).toBe("/agency?error=already_open");
  });

  test("in the last seven days: a new request, with the approved people named again as requests", async () => {
    await owner.query(
      "insert into agency_grant_people (grant_id, user_id, added_by) values ($1, $2, $3)",
      [grant.due, who.worker!.userId, who["agency-owner"]!.userId],
    );
    await owner.query("update agency_grant_people set status = 'approved', decided_by = $2 where grant_id = $1", [
      grant.due,
      who["client-owner"]!.userId,
    ]);
    expect(await reach("worker")).toContain(org.due);

    await as("agency-owner", "agency");
    expect(await act(agencySide.renewGrantAction, { grantId: grant.due! })).toBe("/agency?done=renewal");
    const [renewal] = (
      await owner.query("select * from agency_grants where client_organization_id = $1 and status = 'requested'", [org.due])
    ).rows;
    expect(renewal).toMatchObject({ renews_grant_id: grant.due, role: "editor", duration_days: 30 });
    expect(renewal.reason).toBe("Renewal: Website and print work");
    const people = await owner.query("select user_id, status from agency_grant_people where grant_id = $1", [renewal.id]);
    expect(people.rows).toEqual([{ user_id: who.worker!.userId, status: "requested" }]);
    // Asking twice is one request.
    expect(await act(agencySide.renewGrantAction, { grantId: grant.due! })).toBe("/agency?error=already_open");
    grant.renewal = renewal.id;
  });

  test("the business sees a renewal to decide on; nothing changes until its owner does", async () => {
    await as("client-owner", "due");
    const team = await render(() => TeamPage({ searchParams: Promise.resolve({}) }));
    expect(team.rendered).toContain(`agency ${TAG}`);
    expect(team.rendered).toContain("asks to renew its");
    // The old grant still carries the person until its own end.
    expect(await reach("worker")).toContain(org.due);

    await as("client-manager", "due");
    expect(await act(businessSide.approveGrantAction, { grantId: grant.renewal!, role: "editor", days: "30" })).toBe(
      "/access?reason=role_lacks_action",
    );
    await as("client-owner", "due");
    expect(await act(businessSide.approveGrantAction, { grantId: grant.renewal!, role: "editor", days: "30" })).toBe(
      "/team?agency=approved#agency",
    );
    // Approved, the renewal opens nothing for the person until they are approved on it too.
    await owner.query("update agency_grants set expires_at = now() - interval '1 second' where id = $1", [grant.due]);
    expect(await reach("worker")).not.toContain(org.due);
    await as("client-owner", "due");
    expect(
      await act(businessSide.decideAgencyPersonAction, { grantId: grant.renewal!, userId: who.worker!.userId, decision: "approved" }),
    ).toBe("/team?agency=person_approved#agency");
    expect(await reach("worker")).toContain(org.due);
  });

  test("a grant outlasted by an approved renewal is not reminded about", async () => {
    await owner.query(
      `insert into agency_grants (client_organization_id, agency_organization_id, reason, requested_by)
       values ($1, $2, 'Website and print work', $3)`,
      [org.renewed, org.agency, who["agency-owner"]!.userId],
    );
    const [r] = (await owner.query("select id from agency_grants where client_organization_id = $1 and status = 'requested'", [org.renewed]))
      .rows;
    await owner.query("update agency_grants set status = 'active', decided_by = $2, expires_at = now() + interval '30 days' where id = $1", [
      r.id,
      who["client-owner"]!.userId,
    ]);
    const due = (await dueExpiryReminders()).map((d) => d.grantId);
    expect(due).not.toContain(grant.renewed);
  });
});

describe("the link in the email", () => {
  const page = () => render(() => GrantPage({ params: Promise.resolve({ id: grant.due! }) }));

  test("the business's owner, with it open, goes straight to the grant on the Team page", async () => {
    await as("client-owner", "due");
    expect(await page()).toEqual({ redirect: `/team#grant-${grant.due}` });
  });

  test("with another business open, it offers to open the right one, then lands on the grant", async () => {
    await as("client-owner", "later");
    const shown = await page();
    expect(shown.rendered).toContain(`Open due ${TAG}`);
    expect(
      await act(switchBusinessAction, { organizationId: org.due!, next: `/team#grant-${grant.due}` }),
    ).toBe(`/team#grant-${grant.due}`);
  });

  test("the agency's owner goes to the Agency page", async () => {
    await as("agency-owner", "agency");
    expect(await page()).toEqual({ redirect: `/agency#grant-${grant.due}` });
  });

  test("nobody else: the agency's own people, another business, a made-up id", async () => {
    await as("worker", "agency");
    expect(await page()).toEqual({ redirect: "404" });
    await as("outsider", "elsewhere");
    expect(await page()).toEqual({ redirect: "404" });
    await as("client-owner", "due");
    expect(await render(() => GrantPage({ params: Promise.resolve({ id: randomUUID() }) }))).toEqual({ redirect: "404" });
    expect(await render(() => GrantPage({ params: Promise.resolve({ id: "not-a-grant" }) }))).toEqual({ redirect: "404" });
  });

  test("signed out: sign in, then back to the grant", async () => {
    browser.token = null;
    expect(await page()).toEqual({ redirect: `/auth/sso/start?path=${encodeURIComponent(`/grants/${grant.due}`)}` });
  });

  test("switching never follows a return path off the portal", async () => {
    await as("client-owner", "later");
    for (const next of ["//evil.example/x", "https://evil.example/", "/auth/sso/start"]) {
      expect(await act(switchBusinessAction, { organizationId: org.due!, next }), next).toBe("/dashboard");
    }
  });
});
