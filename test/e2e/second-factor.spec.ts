import { expect, test } from "@playwright/test";
import { latestCodeFor, resetSignInState, signIn, totpCode } from "./helpers";

/**
 * Staff carry a second factor; clients do not.
 *
 * The asymmetry is the point. A client session reaches one company's jobs. A
 * staff session reaches every client, and its first factor is a code sent to an
 * inbox — the single thing most likely to be compromised, since it is also
 * where password resets for everything else arrive.
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
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(STAFF));
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/auth\/2fa/);
    await expect(page.getByText("Set up your authenticator")).toBeVisible();
  });

  test("a half-signed-in staff session can reach nothing", async ({ page }) => {
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Send me a code" }).click();
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
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(STAFF));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/auth\/2fa/);

    await page.getByRole("button", { name: "Start setup" }).click();
    await page.waitForURL(/\/auth\/2fa/);

    await page.getByLabel("Six-digit code").fill("000000");
    await page.getByRole("button", { name: /Confirm and continue/ }).click();

    await expect(page.getByRole("alert")).toContainText("did not work");
    expect(page.url()).toContain("/auth/2fa");
  });

  test("once enrolled, signing in again asks for the code rather than setup", async ({
    page,
    context,
  }) => {
    // First sign-in: enrol, keeping the key.
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(STAFF));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/auth\/2fa/);
    await page.getByRole("button", { name: "Start setup" }).click();
    await page.waitForURL(/\/auth\/2fa/);

    const key = (
      await page.getByText(/^[A-Z2-7 ]{20,}$/).first().innerText()
    ).replace(/\s+/g, "");

    await page.getByLabel("Six-digit code").fill(totpCode(key));
    await page.getByRole("button", { name: /Confirm and continue/ }).click();
    // Not a fixed path: the landing page has moved once already, and a test
    // pinned to it breaks for a reason that has nothing to do with what it
    // is checking.
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));

    // Second sign-in, clean browser: the secret is already confirmed, so the
    // setup key must NOT be shown again.
    await context.clearCookies();
    await page.goto("/auth/login");
    await page.getByLabel("Email").fill(STAFF);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await latestCodeFor(STAFF));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/auth\/2fa/);

    await expect(page.getByText("Second step")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start setup" })).toHaveCount(0);
    await expect(page.getByText(/^[A-Z2-7 ]{20,}$/)).toHaveCount(0);

    await page.getByLabel("Six-digit code").fill(totpCode(key));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));
    await expect(page.getByText("10XiD Portal")).toBeVisible();
  });
});
