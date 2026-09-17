import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { expectSignedIn, resetSignInState, signIn } from "./helpers";

/**
 * The intake endpoint, over real HTTP.
 *
 * The database tests prove the policies. This proves the thing on the end of
 * the wire behaves: that a key gets a job in, that a wrong one gets 401 and
 * nothing else, and — the point of the whole exercise — that work filed by a
 * machine shows up on the right client's screens and on no other client's.
 */

const STAFF = "paolo@brandingcentres.test";
const CLIENT = "jane@rotary.test";

/**
 * A label nothing else will share.
 *
 * Keys are never deleted — revoking is a timestamp — so rows from previous runs
 * are still there on the next one. A fixed label therefore matches two elements
 * the second time the suite is run, which is a test failing for a reason that
 * has nothing to do with the code. Found exactly that way.
 */
const unique = (what: string) => `e2e ${what} ${Date.now()}`;

/**
 * Mint a key by talking to the database directly.
 *
 * The staff screen is exercised separately below. Doing it here as well would
 * make every one of these tests depend on that screen's markup, so a rename of
 * a button would fail tests that are about the endpoint.
 */
async function mintKeyFor(slug: string, label: string): Promise<string> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { randomBytes, createHash } = await import("node:crypto");
    const secret = "10xid_live_" + randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(secret, "utf8").digest();

    const { rows } = await db.query(
      "select id from organizations where slug = $1",
      [slug],
    );
    const orgId = rows[0].id;

    const account = await db.query(
      `insert into users (email, full_name, is_service, is_staff)
       values ($1, $2, true, false) returning id`,
      [`${slug}-${randomBytes(4).toString("hex")}@service.10xid.invalid`, label],
    );
    await db.query(
      `insert into memberships (user_id, organization_id, role)
       values ($1, $2, 'member')`,
      [account.rows[0].id, orgId],
    );

    const staff = await db.query(
      "select id from users where email = $1",
      [STAFF],
    );
    await db.query(
      `insert into api_keys
         (organization_id, service_user_id, label, key_hash, prefix, created_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [orgId, account.rows[0].id, label, hash, secret.slice(0, 17), staff.rows[0].id],
    );

    return secret;
  } finally {
    await db.end();
  }
}

test.describe("filing a job with a key", () => {
  test("a valid key files work and gets the reference back", async ({
    request,
  }) => {
    const key = await mintKeyFor("northstar", unique("valid key"));

    const response = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
      data: {
        title: "Estimate request — 2400 sq ft asphalt shingle",
        details: {
          name: "Dana Whitfield",
          email: "dana@example.test",
          property: "18 Elmwood Crescent, Barrie",
        },
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.ref).toMatch(/^NOR-\d{4}$/);
    expect(body.status).toBe("open");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("no key, a malformed key and an unknown key are all the same 401", async ({
    request,
  }) => {
    const attempts = [
      {},
      { authorization: "Bearer" },
      { authorization: "Bearer hunter2" },
      { authorization: `Bearer 10xid_live_${"A".repeat(43)}` },
      { authorization: "Basic YWRtaW46YWRtaW4=" },
    ];

    const bodies = new Set<string>();
    for (const headers of attempts) {
      const response = await request.post("/api/v1/jobs", {
        headers: headers as Record<string, string>,
        data: { title: "should not be filed" },
      });
      expect(response.status()).toBe(401);
      bodies.add(await response.text());
    }

    // One answer for all of them. If these differed, the endpoint would be
    // telling a caller which of their guesses was closest to a real key.
    expect(bodies.size).toBe(1);
  });

  test("a revoked key stops working", async ({ request }) => {
    const label = unique("to be revoked");
    const key = await mintKeyFor("northstar", label);

    const before = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
      data: { title: "Filed while the key was live" },
    });
    expect(before.status()).toBe(201);

    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI supplies the environment */
    }
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query("update api_keys set revoked_at = now() where label = $1", [
      label,
    ]);
    await db.end();

    const after = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
      data: { title: "Filed after revocation" },
    });
    expect(after.status()).toBe(401);
  });

  test("a bad body is refused before anything is written", async ({
    request,
  }) => {
    const key = await mintKeyFor("northstar", unique("bad body"));

    const short = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
      data: { title: "no" },
    });
    expect(short.status()).toBe(400);
    expect((await short.json()).error).toBe("invalid_body");

    const notJson = await request.post("/api/v1/jobs", {
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      data: "{ not json",
    });
    expect(notJson.status()).toBe(400);
  });

  test("there is no way to read jobs back out with a key", async ({
    request,
  }) => {
    const key = await mintKeyFor("northstar", unique("read attempt"));

    const response = await request.get("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.status()).toBe(405);
    expect(response.headers()["allow"]).toBe("POST");
  });

  test("the endpoint sends no CORS headers, so a browser cannot use a key", async ({
    request,
  }) => {
    const key = await mintKeyFor("northstar", unique("cors"));

    const response = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.test" },
      data: { title: "Filed from a page on another origin" },
    });

    // The request itself succeeds — this is a server-to-server endpoint and it
    // does not care who calls it. What must NOT come back is permission for a
    // browser to read the response, because that is what would make putting a
    // key in page JavaScript look like it works.
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  });
});

test.describe("what the client sees afterwards", () => {
  test.beforeEach(resetSignInState);

  test("the job and its submitted details appear on the client's screens", async ({
    page,
    request,
  }) => {
    const key = await mintKeyFor("northstar", unique("visible to client"));
    const title = `Estimate request ${Date.now()}`;

    const filed = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
      data: {
        title,
        details: {
          name: "Dana Whitfield",
          property: "18 Elmwood Crescent",
          notes: "Two layers of shingle, north face is worst.",
        },
      },
    });
    expect(filed.status()).toBe(201);
    const { id } = await filed.json();

    // Staff can see every client, so they are the account that can open a
    // Northstar job without a Northstar login existing in the seed.
    await signIn(page, STAFF, `/jobs/${id}`);
    await expectSignedIn(page);

    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText("Submitted details")).toBeVisible();
    await expect(page.getByText("Dana Whitfield")).toBeVisible();
    await expect(
      page.getByText("Two layers of shingle, north face is worst."),
    ).toBeVisible();
  });

  test("another client cannot open it by its exact id", async ({
    page,
    request,
  }) => {
    const key = await mintKeyFor("northstar", unique("not visible to rotary"));

    const filed = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
      data: { title: "Northstar work Rotary must never see" },
    });
    const { id } = await filed.json();

    // The whole point of the exercise: work that arrived from a machine is
    // scoped exactly like work that arrived from a person.
    await signIn(page, CLIENT, "/dashboard");
    await expectSignedIn(page);

    const response = await page.goto(`/jobs/${id}`);
    expect(response?.status()).toBe(404);
    await expect(
      page.getByText("Northstar work Rotary must never see"),
    ).toHaveCount(0);
  });
});

test.describe("the staff screen", () => {
  test.beforeEach(resetSignInState);

  test("minting shows the key once, and it works", async ({
    page,
    request,
  }) => {
    await signIn(page, STAFF, "/staff");
    await expectSignedIn(page);

    // Writing into a client's data needs a grant with a reason, so the screen
    // refuses to mint until one is held.
    await page.goto("/staff/keys");
    await expect(page.getByText("You are looking at every client")).toBeVisible();

    await page.goto("/staff");
    const row = page.locator("li", { hasText: "Northstar" }).first();
    await row.getByRole("textbox").fill("Setting up their website integration");
    await row.getByRole("button", { name: "Open" }).click();
    await page.waitForURL(/\/jobs/);

    const label = unique("minted from the screen");
    await page.goto("/staff/keys");
    await page.getByLabel(/New key for/).fill(label);
    await page.getByRole("button", { name: "Mint key" }).click();

    await expect(page.getByText("Copy this now")).toBeVisible();
    const shown = (await page.locator("pre").first().innerText()).trim();
    expect(shown.startsWith("10xid_live_")).toBe(true);

    // The key the screen displayed is a working key — not a mock-up of one.
    const response = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${shown}` },
      data: { title: "Filed with the key the staff screen just showed" },
    });
    expect(response.status()).toBe(201);
    expect((await response.json()).ref).toMatch(/^NOR-\d{4}$/);

    // Reloading the list must not show it again — only its prefix.
    await page.goto("/staff/keys");
    await expect(page.getByText(shown)).toHaveCount(0);
    await expect(page.getByText(label)).toBeVisible();
  });

  test("revoking from the screen stops the key", async ({ page, request }) => {
    const label = unique("revoked from the screen");
    const key = await mintKeyFor("northstar", label);

    await signIn(page, STAFF, "/staff");
    const row = page.locator("li", { hasText: "Northstar" }).first();
    await row.getByRole("textbox").fill("Revoking a key that leaked");
    await row.getByRole("button", { name: "Open" }).click();
    await page.waitForURL(/\/jobs/);

    await page.goto("/staff/keys");
    const keyRow = page.locator("li", { hasText: label });
    await keyRow.getByRole("button", { name: "Revoke" }).click();

    await expect(page.getByText("Key revoked")).toBeVisible();

    const response = await request.post("/api/v1/jobs", {
      headers: { authorization: `Bearer ${key}` },
      data: { title: "Filed after the screen revoked the key" },
    });
    expect(response.status()).toBe(401);
  });
});
