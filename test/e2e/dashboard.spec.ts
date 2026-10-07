import { expect, test } from "@playwright/test";
import { resetSignInState, signIn, openAccountMenu } from "./helpers";

/**
 * The dashboard and team screens.
 *
 * Both are scoped like everything else, so the tests that matter are the ones
 * checking a client's figures cover their own company and nobody else's.
 */

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";

test.describe("dashboard", () => {
  test.beforeEach(resetSignInState);

  test("signing in lands on the dashboard", async ({ page }) => {
    await signIn(page, CLIENT, "/");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("shows the figures and the recent list", async ({ page }) => {
    await signIn(page, CLIENT, "/dashboard");

    await expect(page.getByText("Open pipeline")).toBeVisible();
    await expect(page.getByText("Completion rate")).toBeVisible();
    await expect(page.getByText("Jobs by status")).toBeVisible();
    await expect(page.getByText("Recent jobs")).toBeVisible();

    // The list has entries, and none of them belong to another client.
    // Deliberately not asserting a specific seeded title: the suite creates
    // jobs as it runs, so the six most recent are not a fixed set.
    const rows = page.locator("a[href^='/jobs/']");
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(page.getByText("Fleet vehicle wrap")).toHaveCount(0);
    await expect(page.getByText("Northstar")).toHaveCount(0);
  });

  test("a client's totals count only their own company", async ({ page }) => {
    await signIn(page, CLIENT, "/dashboard");
    const clientTotal = await page
      .locator("div", { hasText: /^Total jobs/ })
      .first()
      .innerText();

    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/auth\/login/);

    await signIn(page, STAFF, "/dashboard");
    const staffTotal = await page
      .locator("div", { hasText: /^Total jobs/ })
      .first()
      .innerText();

    // Staff survey every client, so their total must exceed one client's.
    const n = (s: string) => Number(s.match(/\d+/g)?.[0] ?? 0);
    expect(n(staffTotal)).toBeGreaterThan(n(clientTotal));
  });
});

test.describe("team", () => {
  test.beforeEach(resetSignInState);

  test("a client sees their own colleagues", async ({ page }) => {
    await signIn(page, CLIENT, "/team");

    await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
    // The company name in the standfirst, not the copy of the address that
    // also sits in the header bar.
    await expect(page.getByRole("strong").filter({ hasText: "Rotary" })).toBeVisible();
    await expect(page.getByText(`${CLIENT} · owner`)).toBeVisible();
    await expect(page.getByText("you", { exact: true })).toBeVisible();

    // Column headings for what each person has moved.
    await expect(page.getByText("Sent out").first()).toBeVisible();
    await expect(page.getByText("Received").first()).toBeVisible();
  });

  test("staff see the internal team", async ({ page }) => {
    await signIn(page, STAFF, "/team");
    await expect(
      page.getByRole("strong").filter({ hasText: "Branding Centres" }),
    ).toBeVisible();
    await expect(page.getByText(`${STAFF} · staff`)).toBeVisible();
  });

  test("a client never sees another company's people", async ({ page }) => {
    await signIn(page, CLIENT, "/team");
    await expect(page.getByText("sam@northstar.test")).toHaveCount(0);
    await expect(page.getByText("Northstar")).toHaveCount(0);
  });
});
