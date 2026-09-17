import { expect, test } from "@playwright/test";
import { Client } from "pg";
import {
  expectSignedIn,
  latestCodeFor,
  resetSignInState,
  signIn,
  signOut,
} from "./helpers";

/**
 * Setting up an account for the first time.
 *
 * The claim being tested is narrow: an address gets an account only if somebody
 * who already had access invited it, and the company that account lands in
 * comes off the invitation rather than from anything typed into the form.
 *
 * The screen exists because signing up and signing in are genuinely different
 * journeys now — one is an emailed code and an authenticator to set up, the
 * other is an authenticator code and nothing else.
 */

const STAFF = "paolo@brandingcentres.test";
const CLIENT = "jane@rotary.test";

/** A fresh address each run: invitations and accounts both persist. */
const newcomer = () => `newcomer-${Date.now()}@rotary.test`;

async function db() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

/** Invite through the database, so these tests do not hinge on Team's markup. */
async function invite(email: string, slug: string, role = "member") {
  const conn = await db();
  try {
    const { rows } = await conn.query(
      `select (select id from organizations where slug = $1) as org,
              (select id from users where email = $2) as inviter`,
      [slug, STAFF],
    );
    await conn.query(
      `insert into invitations (email, organization_id, role, invited_by, expires_at)
       values ($1, $2, $3, $4, now() + interval '14 days')`,
      [email, rows[0].org, role, rows[0].inviter],
    );
  } finally {
    await conn.end();
  }
}

async function accountFor(email: string) {
  const conn = await db();
  try {
    const { rows } = await conn.query(
      `select u.id, u.is_staff, o.slug as company, m.role
         from users u
         left join memberships m on m.user_id = u.id
         left join organizations o on o.id = m.organization_id
        where u.email = $1`,
      [email],
    );
    return rows[0] ?? null;
  } finally {
    await conn.end();
  }
}

test.describe("setting up an account", () => {
  test.beforeEach(resetSignInState);

  test("an invited address gets an account in the inviting company", async ({
    page,
  }) => {
    const email = newcomer();
    await invite(email, "rotary", "member");

    await page.goto("/auth/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();

    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(email));
    await page.getByRole("button", { name: "Sign in" }).click();

    await expectSignedIn(page);

    // The company came off the invitation, not from anything typed in.
    const account = await accountFor(email);
    expect(account).not.toBeNull();
    expect(account.company).toBe("rotary");
    expect(account.role).toBe("member");
    expect(account.is_staff).toBe(false);
  });

  test("an uninvited address gets nothing, and says nothing", async ({
    page,
  }) => {
    const email = `stranger-${Date.now()}@nowhere.test`;

    await page.goto("/auth/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();

    // Same screen an invited address reaches — the form must not reveal which
    // addresses have been invited any more than which have accounts.
    await page.waitForURL(/\/auth\/verify/);
    await expect(
      page.getByRole("heading", { name: "Enter your code" }),
    ).toBeVisible();

    // ...and no code was issued, so there is nothing to enter.
    await expect(latestCodeFor(email)).rejects.toThrow(/No sign-in code/);
    expect(await accountFor(email)).toBeNull();
  });

  test("an invitation is spent once", async ({ page, context }) => {
    const email = newcomer();
    await invite(email, "rotary");

    await page.goto("/auth/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(email));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);

    const conn = await db();
    const { rows } = await conn.query(
      "select accepted_at from invitations where email = $1",
      [email],
    );
    await conn.end();
    expect(rows[0].accepted_at).not.toBeNull();

    // Second time round it is an ordinary sign-in, not a second account.
    await context.clearCookies();
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(email));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);

    const conn2 = await db();
    const { rows: count } = await conn2.query(
      "select count(*)::int as n from users where email = $1",
      [email],
    );
    await conn2.end();
    expect(count[0].n).toBe(1);
  });

  test("a withdrawn invitation stops working", async ({ page }) => {
    const email = newcomer();
    await invite(email, "rotary");

    const conn = await db();
    await conn.query(
      "update invitations set revoked_at = now() where email = $1",
      [email],
    );
    await conn.end();

    await page.goto("/auth/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await expect(latestCodeFor(email)).rejects.toThrow(/No sign-in code/);
    expect(await accountFor(email)).toBeNull();
  });

  test("an invitation into one client cannot land in another", async ({
    page,
  }) => {
    const email = newcomer();
    await invite(email, "northstar");

    await page.goto("/auth/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(email));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);

    const account = await accountFor(email);
    expect(account.company).toBe("northstar");

    // And what they can see follows from that, not from the address's domain —
    // which reads like a Rotary one and is deliberately not consulted.
    await page.goto("/jobs");
    await expect(page.getByText("District 7070 banner artwork")).toHaveCount(0);
  });
});

test.describe("the two journeys are separate screens", () => {
  test.beforeEach(resetSignInState);

  test("sign in offers a way to set up, and back again", async ({ page }) => {
    await page.goto("/auth/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.getByRole("link", { name: "Set up your account" }).click();
    await page.waitForURL(/\/auth\/signup/);
    await expect(
      page.getByRole("heading", { name: "Set up your account" }),
    ).toBeVisible();

    await page.getByRole("link", { name: /Already set up/ }).click();
    await page.waitForURL(/\/auth\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});

test.describe("who may invite", () => {
  test.beforeEach(resetSignInState);

  test("a client owner can invite into their own company", async ({ page }) => {
    await signIn(page, CLIENT, "/team");
    await expectSignedIn(page);

    const email = newcomer();
    await page.getByLabel(/Invite someone to/).fill(email);
    await page.getByRole("button", { name: "Send invitation" }).click();

    await expect(page.getByText("Invitation sent")).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // Into Rotary, because that is the company the session is scoped to —
    // there is no company field on the form to point somewhere else.
    const conn = await db();
    const { rows } = await conn.query(
      `select o.slug from invitations i
         join organizations o on o.id = i.organization_id
        where i.email = $1`,
      [email],
    );
    await conn.end();
    expect(rows[0].slug).toBe("rotary");
  });

  test("staff surveying every client are told to choose one first", async ({
    page,
  }) => {
    await signIn(page, STAFF, "/team");
    await expectSignedIn(page);

    // No grant held, so no single company to invite into, so no form.
    await expect(page.getByRole("button", { name: "Send invitation" })).toHaveCount(
      0,
    );
  });

  test("withdrawing removes it from the list", async ({ page }) => {
    await signIn(page, CLIENT, "/team");
    const email = newcomer();
    await page.getByLabel(/Invite someone to/).fill(email);
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByText(email)).toBeVisible();

    await page
      .locator("li", { hasText: email })
      .getByRole("button", { name: "Withdraw" })
      .click();

    await expect(page.getByText("Invitation withdrawn")).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
  });
});

test.describe("signing out", () => {
  test.beforeEach(resetSignInState);

  test("a newly created account can sign out and back in", async ({ page }) => {
    const email = newcomer();
    await invite(email, "rotary");

    await page.goto("/auth/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(email));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);

    await signOut(page);

    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(email));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);
  });
});
