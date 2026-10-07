import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { resetSignInState, seededIds, signIn } from "./helpers";

/**
 * Phase 1's second risky claim, through a real browser:
 *
 *   a client sees only their own company's jobs, staff see all of them, and a
 *   client CANNOT reach another client's job by guessing its address.
 *
 * The database-level proof lives in test/isolation.test.ts. This is the same
 * claim from the outside, as a real signed-in person over HTTP, because the two
 * can fail independently: a route could leak what the data layer protects.
 */

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";

test.describe("one client cannot see another", () => {
  test.beforeEach(resetSignInState);

  test("a client sees only their own company's jobs", async ({ page }) => {
    await signIn(page, CLIENT, "/jobs");

    await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
    await expect(page.getByText("ROT-0001")).toBeVisible();

    // Northstar's work must be absent entirely, by reference and by title.
    await expect(page.getByText("NOR-0001")).toHaveCount(0);
    await expect(page.getByText("Fleet vehicle wrap")).toHaveCount(0);
  });

  test("staff see every client's jobs", async ({ page }) => {
    await signIn(page, STAFF, "/jobs");

    await expect(page.getByText("ROT-0001")).toBeVisible();
    await expect(page.getByText("NOR-0001")).toBeVisible();
  });

  test("a client guessing another client's job address gets nothing", async ({
    page,
  }) => {
    const ids = await seededIds();
    await signIn(page, CLIENT, "/jobs");

    // Their own job opens normally — so the route demonstrably works.
    const ok = await page.goto(`/jobs/${ids.rotary_job}`);
    expect(ok?.status()).toBe(200);
    await expect(page.getByText("ROT-0001")).toBeVisible();

    // The other client's job, by its exact real id.
    const attempt = await page.goto(`/jobs/${ids.northstar_job}`);
    expect(attempt?.status()).toBe(404);
    await expect(page.getByText(ids.northstar_title)).toHaveCount(0);

    // An id that never existed gives the same answer, so the endpoint does not
    // confirm which ids are real and cannot be walked to enumerate a
    // competitor's workload.
    const imaginary = await page.goto(
      "/jobs/00000000-0000-4000-8000-000000000000",
    );
    expect(imaginary?.status()).toBe(404);
  });

  test("staff acting on one client stop seeing the others", async ({ page }) => {
    await signIn(page, STAFF, "/staff");

    await page
      .getByLabel("Reason for opening Rotary")
      .fill("client emailed about a proof");
    await page
      .locator("form", { has: page.getByLabel("Reason for opening Rotary") })
      .getByRole("button", { name: "Open" })
      .click();

    await page.waitForURL(/\/jobs/);

    // The banner names the client and the reason, and stays put.
    await expect(page.getByText("Acting on")).toBeVisible();
    await expect(page.getByText("client emailed about a proof")).toBeVisible();

    // Scoped now: Rotary only, exactly like a Rotary user.
    await expect(page.getByText("ROT-0001")).toBeVisible();
    await expect(page.getByText("NOR-0001")).toHaveCount(0);
  });

  test("giving up the grant restores the overview", async ({ page }) => {
    await signIn(page, STAFF, "/staff");
    await page
      .getByLabel("Reason for opening Rotary")
      .fill("checking a proof for the client");
    await page
      .locator("form", { has: page.getByLabel("Reason for opening Rotary") })
      .getByRole("button", { name: "Open" })
      .click();
    await page.waitForURL(/\/jobs/);
    await expect(page.getByText("NOR-0001")).toHaveCount(0);

    await page.getByRole("button", { name: "Exit" }).click();
    await page.waitForURL(/\/staff/);

    await page.goto("/jobs");
    await expect(page.getByText("NOR-0001")).toBeVisible();
    await expect(page.getByText("Acting on")).toHaveCount(0);
  });

  test("staff surveying every client cannot create a job", async ({ page }) => {
    await signIn(page, STAFF, "/jobs");

    // No client chosen: the form is replaced by an instruction, so the
    // impossible action is not offered in the first place.
    await expect(page.getByLabel("Job title")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Choose a client" }),
    ).toBeVisible();
  });

  test("a client can create a job, and it lands in their own company", async ({
    page,
  }) => {
    await signIn(page, CLIENT, "/jobs");

    // A unique title per run: the suite runs against a database that keeps its
    // rows, and across four browser profiles, so a fixed string matches every
    // copy a previous run left behind.
    const title = `Spring drive banner ${randomUUID().slice(0, 8)}`;

    await page.getByLabel("Job title").fill(title);
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForURL(/\/jobs$/);

    await expect(page.getByText(title)).toBeVisible();
    // Allocated the next reference in ROTARY's own sequence — asserted as a
    // pattern, not a fixed number: the counter advances every time the suite
    // runs, and a test that only passes on a pristine database is a test that
    // will be quietly disabled the second time it fails.
    await expect(page.getByText(/^ROT-\d{4}$/).first()).toBeVisible();
  });
});
