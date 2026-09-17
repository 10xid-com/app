import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { expectSignedIn, resetSignInState, signIn } from "./helpers";

/**
 * The Requests board.
 *
 * Everything that has come IN, as cards carrying what the sender actually
 * wrote. The interesting tests are the same ones as everywhere else: a client
 * sees their own and nobody else's, and filing a request into Drive is a write
 * and therefore needs a session scoped to one company.
 */

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";

/** Mint a key and file a request through the real endpoint, as a website would. */
async function fileRequest(
  request: { post: (url: string, opts: object) => Promise<{ status(): number; json(): Promise<{ id: string; ref: string }> }> },
  slug: string,
  title: string,
  details: Record<string, string>,
) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const { randomBytes, createHash } = await import("node:crypto");
  const secret = "10xid_live_" + randomBytes(32).toString("base64url");

  const { rows } = await db.query(
    `select (select id from organizations where slug = $1) as org,
            (select id from users where email = $2) as staff`,
    [slug, STAFF],
  );
  const account = await db.query(
    `insert into users (email, full_name, is_service, is_staff)
     values ($1, 'requests spec', true, false) returning id`,
    [`${slug}-${randomBytes(4).toString("hex")}@service.10xid.invalid`],
  );
  await db.query(
    `insert into memberships (user_id, organization_id, role) values ($1,$2,'member')`,
    [account.rows[0].id, rows[0].org],
  );
  await db.query(
    `insert into api_keys
       (organization_id, service_user_id, label, key_hash, prefix, created_by)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      rows[0].org,
      account.rows[0].id,
      `requests spec ${Date.now()}`,
      createHash("sha256").update(secret, "utf8").digest(),
      secret.slice(0, 17),
      rows[0].staff,
    ],
  );
  await db.end();

  const response = await request.post("/api/v1/jobs", {
    headers: { authorization: `Bearer ${secret}` },
    data: { title, details },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

test.describe("requests on the dashboard", () => {
  test.beforeEach(resetSignInState);

  test("an incoming request appears as a card with what was written", async ({
    page,
    request,
  }) => {
    const title = `Estimate request ${Date.now()}`;
    await fileRequest(request, "rotary", title, {
      name: "Dana Whitfield",
      email: "dana@example.test",
      phone: "705-555-0144",
      message: "Two layers of shingle on a 1960s bungalow.",
    });

    await signIn(page, CLIENT, "/dashboard");
    await expectSignedIn(page);

    // Scoped to the Requests board: the same title also appears in the recent
    // jobs list above it, and a bare `li` selector matches both.
    const board = page.getByRole("region", { name: "Requests" });
    await expect(board).toBeVisible();

    const card = board.locator("li", { hasText: title });
    await expect(card).toBeVisible();
    // The information is ON the card — that is the point of a card rather than
    // a row, since a request is mostly prose.
    await expect(card.getByText("Dana Whitfield")).toBeVisible();
    await expect(card.getByText("dana@example.test")).toBeVisible();
    await expect(card.getByText("705-555-0144")).toBeVisible();
    await expect(
      card.getByText("Two layers of shingle on a 1960s bungalow."),
    ).toBeVisible();
  });

  test("a client never sees another client's request card", async ({
    page,
    request,
  }) => {
    const title = `Northstar only ${Date.now()}`;
    await fileRequest(request, "northstar", title, { name: "Someone Else" });

    await signIn(page, CLIENT, "/dashboard");
    await expectSignedIn(page);

    await expect(page.getByText(title)).toHaveCount(0);
    await expect(page.getByText("Someone Else")).toHaveCount(0);
  });

  test("staff surveying every client see requests but cannot file them", async ({
    page,
    request,
  }) => {
    const title = `Survey view ${Date.now()}`;
    await fileRequest(request, "northstar", title, { name: "Dana Whitfield" });

    await signIn(page, STAFF, "/dashboard");
    await expectSignedIn(page);

    const board = page.getByRole("region", { name: "Requests" });
    await expect(board.getByText(title)).toBeVisible();

    // Filing writes onto one client's job, and no client is chosen, so the
    // button is not offered. Hiding it is only tidiness — the action refuses on
    // the same grounds, and the tenant policy refuses underneath that, both
    // asserted in test/isolation.test.ts.
    const card = board.locator("li", { hasText: title });
    await expect(
      card.getByRole("button", { name: "Create Drive folder" }),
    ).toHaveCount(0);
    await expect(card.getByText(/Choose a client|Drive not connected/)).toBeVisible();
  });

  test("a card links through to the job", async ({ page, request }) => {
    const title = `Linkable ${Date.now()}`;
    const { id } = await fileRequest(request, "rotary", title, {
      name: "Dana Whitfield",
    });

    await signIn(page, CLIENT, "/dashboard");
    await page
      .getByRole("region", { name: "Requests" })
      .locator("li", { hasText: title })
      .getByRole("link")
      .first()
      .click();

    await page.waitForURL(new RegExp(`/jobs/${id}`));
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  });

  test("jobs sent the other way are not requests", async ({ page }) => {
    // Requests are what came IN. Work going out belongs on the jobs list, not
    // on a board whose whole purpose is "somebody is waiting on us".
    await signIn(page, CLIENT, "/jobs");
    await expectSignedIn(page);

    const outgoing = `Outgoing ${Date.now()}`;
    await page.getByLabel("Job title").fill(outgoing);
    await page.getByLabel("Direction").selectOption("to_client");
    await page.getByRole("button", { name: "Send" }).click();

    // It exists as a job...
    await expect(page.getByText(outgoing)).toBeVisible();

    // ...but not on the Requests board, whose whole purpose is "somebody is
    // waiting on us".
    await page.goto("/dashboard");
    const board = page.getByRole("region", { name: "Requests" });
    await expect(board.getByText(outgoing)).toHaveCount(0);
  });
});

test.describe("filing a request into Drive", () => {
  test.beforeEach(resetSignInState);

  test("without a configured service account the button is not offered", async ({
    page,
    request,
  }) => {
    // This deployment has no Google credentials, which is the honest default:
    // the integration is inert rather than half-working.
    const title = `Unconfigured ${Date.now()}`;
    await fileRequest(request, "rotary", title, { name: "Dana Whitfield" });

    await signIn(page, CLIENT, "/dashboard");
    const card = page
      .getByRole("region", { name: "Requests" })
      .locator("li", { hasText: title });

    await expect(card.getByText("Drive not connected")).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Create Drive folder" }),
    ).toHaveCount(0);
  });

});
