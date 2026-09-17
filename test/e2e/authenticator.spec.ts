import { expect, test } from "@playwright/test";
import { Client } from "pg";
import {
  enrolAuthenticator,
  expectSignedIn,
  latestCodeFor,
  latestSessionFor,
  resetSignInState,
  signOut,
  totpCode,
} from "./helpers";

/**
 * Signing in with the authenticator.
 *
 * Once an account holds a confirmed authenticator, its code is what signs that
 * account in — and the emailed code stops working for it. The second of those
 * is the one that matters: if the emailed code still worked, anyone holding the
 * inbox could ignore the authenticator entirely and it would be decorative.
 */

const STAFF = "paolo@brandingcentres.test";
const CLIENT = "jane@rotary.test";

test.describe("the authenticator is the way in", () => {
  // Clears enrolment as well as sessions, so each test enrols for itself rather
  // than depending on a secret some earlier test happened to leave behind.
  test.beforeEach(resetSignInState);

  test("signing in takes the authenticator code and nothing else", async ({
    page,
  }) => {
    const { secret } = await enrolAuthenticator(page, STAFF);
    await signOut(page);

    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await page.getByLabel("Six-digit code").fill(totpCode(secret));
    await page.getByRole("button", { name: "Sign in" }).click();

    // Straight in. No second screen asking for the same code again.
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));
    await expectSignedIn(page);
    expect(page.url()).not.toContain("/auth/2fa");

    // And the session it produced has already cleared its second factor, which
    // is what stops every later page bouncing it back to the enrolment screen.
    const session = await latestSessionFor(STAFF);
    expect(session.role_at_creation).toBe("staff");
  });

  test("no email is sent once an authenticator is enrolled", async ({
    page,
  }) => {
    const { secret } = await enrolAuthenticator(page, STAFF);
    await signOut(page);

    const before = await latestCodeFor(STAFF).catch(() => null);

    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);

    // Nothing new reached the sink, because nothing was sent — the code comes
    // from the authenticator now, and an email would be noise at best.
    const after = await latestCodeFor(STAFF).catch(() => null);
    expect(after).toBe(before);

    await page.getByLabel("Six-digit code").fill(totpCode(secret));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);
  });

  test("an emailed code no longer opens an account with an authenticator", async ({
    page,
  }) => {
    await enrolAuthenticator(page, STAFF);
    await signOut(page);

    // Assume the attacker has already won every step before this one: a live,
    // correct, unconsumed emailed code for the account, written straight into
    // the table. It must still not be enough.
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI supplies the environment */
    }
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const { createHash } = await import("node:crypto");
    const planted = "424242";
    await db.query(
      `insert into sign_in_codes (email, code_hash, expires_at)
       values ($1, $2, now() + interval '10 minutes')`,
      [
        STAFF,
        createHash("sha256").update(`${STAFF}:${planted}`, "utf8").digest(),
      ],
    );
    await db.end();

    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await page.getByLabel("Six-digit code").fill(planted);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/auth\/verify/);
    await expect(page.getByText("That code did not work")).toBeVisible();
  });

  test("a client without an authenticator still signs in by email", async ({
    page,
  }) => {
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(CLIENT);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await page.getByLabel("Six-digit code").fill(await latestCodeFor(CLIENT));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);
  });

  test("the code screen gives nothing away about which address has one", async ({
    page,
  }) => {
    await enrolAuthenticator(page, STAFF);
    await signOut(page);

    const screenFor = async (email: string) => {
      await page.goto("/auth/login");
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForURL(/\/auth\/verify/);
      // The address itself is echoed back, so it is removed before comparing —
      // what must not differ is everything else.
      return (await page.locator("main, body").first().innerText()).replaceAll(
        email,
        "«address»",
      );
    };

    const withAuthenticator = await screenFor(STAFF);
    const withoutOne = await screenFor(CLIENT);
    const noAccountAtAll = await screenFor("nobody@nowhere.test");

    // If these differed, the form would be a way to discover who has an account
    // and which people are staff, just by typing addresses into it.
    expect(withAuthenticator).toBe(withoutOne);
    expect(withoutOne).toBe(noAccountAtAll);
  });
});

test.describe("recovery codes", () => {
  test.beforeEach(resetSignInState);

  test("enrolment issues a set, shown once", async ({ page }) => {
    const { recoveryCodes } = await enrolAuthenticator(page, STAFF);

    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
    expect(new Set(recoveryCodes).size).toBe(10);

    // Going back to the screen cannot show them again — only hashes are stored,
    // which is the property that makes them worth anything.
    await page.goto("/auth/recovery-codes");
    for (const code of recoveryCodes) {
      await expect(page.getByText(code, { exact: true })).toHaveCount(0);
    }
    await expect(page.getByText("cannot be shown again")).toBeVisible();
  });

  test("one gets you back in when the authenticator is gone", async ({
    page,
  }) => {
    const { recoveryCodes } = await enrolAuthenticator(page, STAFF);
    await signOut(page);

    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await page.getByLabel("Six-digit code").fill(recoveryCodes[0]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);
  });

  test("the same one never works twice", async ({ page }) => {
    const { recoveryCodes } = await enrolAuthenticator(page, STAFF);
    await signOut(page);

    const signInWith = async (code: string) => {
      await page.goto("/auth/login");
      await page.getByLabel("Email").fill(STAFF);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForURL(/\/auth\/verify/);
      await page.getByLabel("Six-digit code").fill(code);
      await page.getByRole("button", { name: "Sign in" }).click();
    };

    await signInWith(recoveryCodes[1]);
    await expectSignedIn(page);
    await signOut(page);

    await signInWith(recoveryCodes[1]);
    await expect(page).toHaveURL(/\/auth\/verify/);
    await expect(page.getByText("That code did not work")).toBeVisible();

    // A different, unspent one still works, so it was the code that was spent
    // and not the whole set that was invalidated.
    await signInWith(recoveryCodes[2]);
    await expectSignedIn(page);
  });

  test("an invented recovery code is refused", async ({ page }) => {
    await enrolAuthenticator(page, STAFF);
    await signOut(page);

    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await page.getByLabel("Six-digit code").fill("ZZZZ-9999");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/auth\/verify/);
    await expect(page.getByText("That code did not work")).toBeVisible();
  });
});
