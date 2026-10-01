import { expect, test } from "@playwright/test";
import {
  enrolAuthenticator,
  latestCodeFor,
  resetSignInState,
  signIn,
  totpCode,
  pageAlert,
} from "./helpers";

/**
 * Staff carry an authenticator; clients do not.
 *
 * The asymmetry is the point. A client session reaches one company's jobs. A
 * staff session reaches every client, and a code sent to an inbox is the single
 * thing most likely to be compromised, since that inbox is also where password
 * resets for everything else arrive.
 *
 * Which is why, once enrolled, the emailed code stops opening the account
 * entirely rather than sitting alongside the authenticator as a second way in.
 */

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";

test.describe("the staff second factor", () => {
  test.beforeEach(resetSignInState);

  test("a client is never asked for one", async ({ page }) => {
    await signIn(page, CLIENT, "/jobs");
    expect(page.url()).not.toContain("/auth/2fa");
    await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  });

  test("staff are stopped at the second step", async ({ page }) => {
    // Sign in by code only, without clearing the second factor.
    await page.goto("/auth/login?next=%2Fjobs");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(STAFF));
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/auth\/2fa/);
    // The heading, not any text: once hydrated, Next's route announcer reads
    // the same words out from a second, hidden element.
    await expect(
      page.getByRole("heading", { name: "Set up your authenticator" }),
    ).toBeVisible();
  });

  test("a half-signed-in staff session can reach nothing", async ({ page }) => {
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(STAFF));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/auth\/2fa/);

    // Every protected route bounces back to the second step — and the session
    // itself carries no staff scope, so even a route that forgot to redirect
    // would have nothing to show.
    for (const path of ["/jobs", "/staff", "/account/sessions"]) {
      await page.goto(path);
      await page.waitForLoadState("load");
      expect(page.url(), `${path} should require the second step`).toContain(
        "/auth/2fa",
      );
    }
  });

  test("a wrong authenticator code is refused", async ({ page }) => {
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(STAFF));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/auth\/2fa/);

    await page.getByRole("button", { name: "Start setup" }).click();
    await page.waitForURL(/\/auth\/2fa/);

    await page.getByLabel("Six-digit code").fill("000000");
    await page.getByRole("button", { name: /Confirm and continue/ }).click();

    await expect(pageAlert(page)).toContainText("did not work");
    expect(page.url()).toContain("/auth/2fa");
  });

  test("once enrolled, the authenticator becomes the way in", async ({
    page,
    context,
  }) => {
    // First sign-in: emailed code, then enrol, keeping the key.
    const { secret } = await enrolAuthenticator(page, STAFF);

    // Second sign-in, clean browser. The emailed code no longer opens this
    // account at all, so there is no first step to get past — the authenticator
    // code goes straight into the one box, and that is the whole sign-in.
    await context.clearCookies();
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/auth\/verify/);

    await page.getByLabel("Six-digit code").fill(totpCode(secret));
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));
    await expect(page.getByText("10XiD Portal")).toBeVisible();

    // The setup screen is never reached again, so the key cannot be shown a
    // second time — which is what stops a half-authenticated session replacing
    // somebody's second factor with its own.
    expect(page.url()).not.toContain("/auth/2fa");

    await page.goto("/auth/2fa");
    await expect(page.getByText(/^[A-Z2-7 ]{20,}$/)).toHaveCount(0);
  });
});
