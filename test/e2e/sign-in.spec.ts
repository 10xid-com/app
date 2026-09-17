import { expect, test } from "@playwright/test";
import {
  ageNewestSession,
  expectSignedIn,
  latestCodeFor,
  latestSessionFor,
  resetSignInState,
  signIn,
} from "./helpers";

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";
const STRANGER = "nobody@nowhere.test";

test.describe("sign in with an emailed code", () => {
  // Each test starts with a clean rate-limit allowance. See resetSignInState.
  test.beforeEach(resetSignInState);

  test("a known person signs in and lands signed in", async ({ page }) => {
    await signIn(page, CLIENT);
    await expectSignedIn(page);
    await expect(page.getByText(CLIENT)).toBeVisible();
  });

  test("a session lasts until it is signed out", async ({ page }) => {
    await signIn(page, CLIENT);
    await expectSignedIn(page);

    // Asserted against the stored session, not against text on a page: these
    // are the limits that will actually be enforced. Neither clock is set, so
    // nothing ends this session but signing out — and the stored expiry is the
    // browser's own 400-day cookie ceiling rather than a policy, because a row
    // outliving the cookie nobody is sending any more would be pretending.
    const session = await latestSessionFor(CLIENT);
    expect(session).not.toBeNull();
    expect(session.role_at_creation).toBe("client");
    expect(session.idle_seconds).toBeNull();

    const days =
      (new Date(session.absolute_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(399);
    expect(days).toBeLessThan(401);
  });

  test("a staff session has no clocks on it either", async ({ page }) => {
    // Staff were the ones being logged out — 30 minutes idle, 8 hours absolute.
    // Both are gone, and this asserts it where it is enforced rather than
    // trusting the constant that produced it.
    await signIn(page, STAFF);
    await expectSignedIn(page);

    const session = await latestSessionFor(STAFF);
    expect(session.role_at_creation).toBe("staff");
    expect(session.idle_seconds).toBeNull();

    const days =
      (new Date(session.absolute_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(399);
  });

  test("being away for a month does not sign you out", async ({ page }) => {
    await signIn(page, STAFF);
    await expectSignedIn(page);

    // Thirty days of not touching it — well past both clocks that used to end
    // a staff session. The point of the change is that coming back works.
    await ageNewestSession(STAFF, 30);

    await page.goto("/dashboard");
    await expectSignedIn(page);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // And the session is still the same one, not a quietly re-issued substitute.
    const session = await latestSessionFor(STAFF);
    expect(session.revoked_at).toBeNull();
  });

  test("an unknown address is told the same thing as a known one", async ({
    page,
  }) => {
    // Enumeration resistance: the form must not reveal who has an account.
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STRANGER);
    await page.getByRole("button", { name: "Send me a code" }).click();

    await page.waitForURL(/\/auth\/verify/);
    await expect(page.getByText("Check your email")).toBeVisible();

    // ...and no code was actually issued to it.
    await expect(latestCodeFor(STRANGER)).rejects.toThrow(/No sign-in code/);
  });

  test("a wrong code is refused", async ({ page }) => {
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(CLIENT);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await page.getByLabel("Six-digit code").fill("000000");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toContainText("did not work");
  });

  test("a code works once and only once", async ({ page, context }) => {
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(CLIENT);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);

    const code = await latestCodeFor(CLIENT);
    await page.getByLabel("Six-digit code").fill(code);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);

    // Same code, fresh browser state: must be rejected.
    await context.clearCookies();
    await page.goto("/auth/verify?email=" + encodeURIComponent(CLIENT));
    await page.getByLabel("Six-digit code").fill(code);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toContainText("did not work");
  });

  test("repeated code requests are rate limited", async ({ page }) => {
    // A dedicated address, because the limit is per address and this test
    // deliberately exhausts it.
    const email = "ratelimit@rotary.test";

    let sawLimit = false;
    for (let i = 0; i < 7; i++) {
      await page.goto("/auth/login");
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Send me a code" }).click();
      await page.waitForURL(/\/auth\/(verify|login)/);
      if (page.url().includes("error=rate")) {
        sawLimit = true;
        break;
      }
    }

    expect(sawLimit).toBe(true);
    await expect(page.getByRole("alert")).toContainText("Too many codes");
  });

  test("signing out ends the session", async ({ page }) => {
    await signIn(page, CLIENT);
    await expectSignedIn(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/auth\/login/);

    // Going back to a protected page must not restore it.
    await page.goto("/");
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
