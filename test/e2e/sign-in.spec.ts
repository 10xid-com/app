import { expect, test } from "@playwright/test";
import { latestCodeFor, resetSignInState, signIn } from "./helpers";

const CLIENT = "jane@rotary.test";
const STRANGER = "nobody@nowhere.test";

test.describe("sign in with an emailed code", () => {
  // Each test starts with a clean rate-limit allowance. See resetSignInState.
  test.beforeEach(resetSignInState);

  test("a known person signs in and lands signed in", async ({ page }) => {
    await signIn(page, CLIENT);
    await expect(page.getByText(`Signed in as`)).toBeVisible();
    await expect(page.getByText(CLIENT)).toBeVisible();
  });

  test("a client session carries the 30-day cap and no idle timeout", async ({
    page,
  }) => {
    await signIn(page, CLIENT);

    await expect(page.getByText("none")).toBeVisible(); // idle timeout
    const expiry = await page
      .getByRole("definition")
      .filter({ hasText: /\d{4}-\d{2}-\d{2}T/ })
      .innerText();

    const days = (new Date(expiry).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.5);
    expect(days).toBeLessThan(30.5);
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
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));

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
    await page.getByRole("button", { name: "Sign out everywhere" }).click();
    await page.waitForURL(/\/auth\/login/);

    // Going back to a protected page must not restore it.
    await page.goto("/");
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
