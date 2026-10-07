import { expect, test, type Page } from "@playwright/test";
import { expectSignedIn, resetSignInState, signIn, openAccountMenu } from "./helpers";

/**
 * Phase 1's first risky claim: sign in once at the login host, then land
 * already signed in on a site at a GENUINELY DIFFERENT registrable domain,
 * with no second prompt.
 *
 * portal-a.test and portal-b.test are different registrable domains. Two
 * subdomains of one domain would prove nothing — sharing a cookie between
 * those is ordinary browser behaviour, not cross-domain sign-in.
 */

const PRIMARY = "http://login.portal-a.test:3000";
const ROTARY = "http://rotary.portal-b.test:3001";
const NORTHSTAR = "http://northstar.portal-b.test:3001";

const CLIENT = "jane@rotary.test";

/**
 * Record every document request, so the redirect chain itself is the evidence.
 *
 * Deliberately not `framenavigated`: that fires only for the URL the browser
 * finally commits to, after the redirects have been followed. Every
 * intermediate hop — including the one carrying the ticket — is invisible to
 * it, which makes it useless for proving what actually happened in between.
 */
function recordHops(page: Page) {
  const hops: string[] = [];
  page.on("request", (req) => {
    if (req.resourceType() === "document") hops.push(req.url());
  });
  return hops;
}

test.describe("cross-domain sign-in", () => {
  test.beforeEach(resetSignInState);

  test("the two hosts really are different registrable domains", async () => {
    const reg = (u: string) =>
      new URL(u).hostname.split(".").slice(-2).join(".");
    expect(reg(PRIMARY)).toBe("portal-a.test");
    expect(reg(ROTARY)).toBe("portal-b.test");
    expect(reg(PRIMARY)).not.toBe(reg(ROTARY));
  });

  test("signed in at the login host, a client domain needs no second prompt", async ({
    page,
  }) => {
    await signIn(page, CLIENT);
    await expectSignedIn(page);

    const hops = recordHops(page);
    const started = Date.now();
    await page.goto(ROTARY + "/");
    await page.waitForLoadState("load");
    const elapsed = Date.now() - started;

    // Landed on the client domain, signed in, with no form in between.
    expect(new URL(page.url()).host).toBe("rotary.portal-b.test:3001");
    await expectSignedIn(page);
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Six-digit code")).toHaveCount(0);

    // The person never saw a sign-in page during the handoff either.
    expect(hops.some((h) => h.includes("/auth/login"))).toBe(false);
    expect(hops.some((h) => h.includes("/auth/verify"))).toBe(false);

    console.log(`\n  handoff round trip: ${elapsed}ms`);
    console.log(`  hops (${hops.length}):`);
    for (const h of hops) console.log(`    ${h.replace("http://", "")}`);

    expect(elapsed).toBeLessThan(5000);
  });

  test("a cold visit with no session anywhere ends at the login host", async ({
    page,
  }) => {
    const hops = recordHops(page);
    await page.goto(ROTARY + "/");
    await page.waitForLoadState("load");

    // Sign-in happens on the login host and nowhere else. Keyed on the heading
    // rather than on a sentence of body copy — this assertion has now broken
    // twice for a wording change that had nothing to do with what it checks.
    expect(new URL(page.url()).host).toBe("login.portal-a.test:3000");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(hops.some((h) => h.includes("rotary.portal-b.test"))).toBe(true);
  });

  test("signing out at the login host ends the session on the other domain", async ({
    page,
  }) => {
    await signIn(page, CLIENT);
    await page.goto(ROTARY + "/");
    await expectSignedIn(page);

    await page.goto(PRIMARY + "/");
    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/auth\/login/);
    const signedOutAt = Date.now();

    // Poll the other domain until it stops treating this person as signed in.
    let stoppedAt = 0;
    for (let i = 0; i < 40; i++) {
      await page.goto(ROTARY + "/");
      await page.waitForLoadState("load");
      const stillIn = await page
        .getByText("10XiD Portal")
        .isVisible()
        .catch(() => false);
      if (!stillIn) {
        stoppedAt = Date.now();
        break;
      }
      await page.waitForTimeout(250);
    }

    expect(stoppedAt).toBeGreaterThan(0);
    const lag = stoppedAt - signedOutAt;
    console.log(
      `\n  other domain stopped honouring the session after ${lag}ms ` +
        `(one request; the session row is revoked, so there is no token to outlive it)`,
    );
    expect(lag).toBeLessThan(3000);
  });

  test("a spent ticket cannot be used again", async ({ page, context }) => {
    await signIn(page, CLIENT);

    // Capture the callback URL, ticket and all, as it goes past.
    let callbackUrl = "";
    page.on("request", (req) => {
      const u = req.url();
      if (req.resourceType() === "document" && u.includes("/auth/sso/callback")) {
        callbackUrl = u;
      }
    });

    await page.goto(ROTARY + "/");
    await expectSignedIn(page);
    expect(callbackUrl).toContain("ticket=");

    // Replay it with no state cookie and no session: must be refused.
    await context.clearCookies();
    await page.goto(callbackUrl);
    await page.waitForLoadState("load");
    expect(page.url()).toContain("/auth/sso/failed");
  });

  test("a ticket for one client domain is worthless at another", async ({
    page,
  }) => {
    await signIn(page, CLIENT);

    let callbackUrl = "";
    page.on("request", (req) => {
      const u = req.url();
      if (req.resourceType() === "document" && u.includes("/auth/sso/callback")) {
        callbackUrl = u;
      }
    });

    await page.goto(ROTARY + "/");
    await expectSignedIn(page);

    // Same ticket, aimed at the other client's domain.
    const stolen = callbackUrl.replace(
      "rotary.portal-b.test",
      "northstar.portal-b.test",
    );
    await page.goto(stolen);
    await page.waitForLoadState("load");

    expect(page.url()).toContain("/auth/sso/failed");
    expect(new URL(page.url()).host).toBe("northstar.portal-b.test:3001");
  });

  test("an unregistered hostname takes no part in the handoff", async ({
    request,
  }) => {
    const response = await request.get(NORTHSTAR + "/auth/sso/start?path=%2F", {
      headers: { host: "evil.portal-b.test:3001" },
      maxRedirects: 0,
    });
    expect([400, 404]).toContain(response.status());
  });
});
