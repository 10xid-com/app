import type { Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { resetSignInState, settle, signIn } from "./helpers";
import { Client } from "pg";
import { MOCK_ANTHROPIC_URL, startMockAnthropic } from "./mock-anthropic";
import { MOCK_GITHUB_URL, MOCK_REPOSITORY_ID, startMockGitHub } from "./mock-github";

/**
 * The workspace, in a browser.
 *
 * Who gets in and who does not runs always. The grounded-answer tests need the
 * dev server pointed at the Anthropic stand-in (test/e2e/mock-anthropic.ts):
 *
 *   ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm run test:e2e
 *
 * The repository test also needs the GitHub stand-in (test/e2e/mock-github.ts):
 *
 *   GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY="$(openssl genrsa 2048 2>/dev/null)" \
 *   GITHUB_API_URL=http://127.0.0.1:4011
 *
 * Under that, everything except the model is real — the SDK, the job tools,
 * the database rows the receipts panel reads back after a refresh.
 */

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";
const mocked = process.env.ANTHROPIC_BASE_URL === MOCK_ANTHROPIC_URL;
const githubMocked = mocked && process.env.GITHUB_API_URL === MOCK_GITHUB_URL;

/**
 * Start a conversation and wait for ITS address. /chat already opens the most
 * recent conversation, so "the URL has ?c=" is true before the new one exists;
 * typing then would go into the old conversation and be cut off when the new
 * page arrives.
 */
async function newConversation(page: Page) {
  const before = page.url();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForURL((u) => u.href !== before && u.searchParams.has("c"));
  // The address changes a moment before the new conversation's page replaces
  // the old one. Wait until the controls on screen belong to the new one, or a
  // click lands on the previous conversation's buttons.
  const id = new URL(page.url()).searchParams.get("c")!;
  await expect(page.locator('input[name="conversationId"]').first()).toHaveValue(id);
}

let mock: Server | null = null;
let githubMock: Server | null = null;
test.beforeAll(async () => {
  if (mocked) mock = await startMockAnthropic();
  if (githubMocked) githubMock = await startMockGitHub();
});
test.afterAll(async () => {
  await new Promise((r) => (mock ? mock.close(r) : r(null)));
  await new Promise((r) => (githubMock ? githubMock.close(r) : r(null)));
});

test.describe("who gets into the workspace", () => {
  test.beforeEach(resetSignInState);

  test("staff land on it after signing in", async ({ page }) => {
    await signIn(page, STAFF, "/");
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByRole("link", { name: "Chat" })).toBeVisible();
  });

  test("a client is sent to their dashboard, and the endpoint refuses them", async ({ page }) => {
    await signIn(page, CLIENT, "/");
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto("/chat");
    await expect(page).toHaveURL(/\/dashboard/);
    const res = await page.request.post("/api/workspace/conversations/00000000-0000-7000-8000-000000000000/messages", {
      data: { content: "hello" },
    });
    expect(res.status()).toBe(403);
  });

  test("signed out, the endpoint refuses too", async ({ request }) => {
    const res = await request.post("/api/workspace/conversations/00000000-0000-7000-8000-000000000000/messages", {
      data: { content: "hello" },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe("a grounded conversation", () => {
  test.beforeEach(resetSignInState);
  test.skip(!mocked, "Needs ANTHROPIC_BASE_URL pointed at the Anthropic stand-in; see the note at the top.");

  test("open a client, ask about a job, and see exactly what the answer used — after a refresh too", async ({ page }) => {
    await signIn(page, STAFF, "/chat");
    await settle(page);

    // Open Rotary with a reason, from inside the workspace.
    await page.getByRole("combobox", { name: "Client" }).selectOption({ label: "Rotary" });
    await page.getByLabel(/Reason/).fill("Checking a banner job for the e2e test");
    await page.getByRole("button", { name: "Open for 30 minutes" }).click();
    await expect(page.getByText("You are acting on", { exact: false }).or(page.getByText("Acting on"))).toBeVisible();

    await newConversation(page);
    await settle(page);

    // Ask mode by default; Build is visibly unavailable.
    await expect(page.getByRole("button", { name: "Ask", pressed: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Build" })).toBeDisabled();

    await page.getByLabel("Message").fill("What is happening with ROT-0001?");
    await page.keyboard.press("Enter");

    // The answer, with its citation, and the summary line naming engine and client.
    await expect(page.getByText("[JOB", { exact: false }).or(page.getByText("JOB ROT-0001"))).toBeVisible();
    await expect(page.getByText(/Claude — Coding · claude-opus-5-5 · Rotary/)).toBeVisible();

    // Survives a refresh: it was saved, not just drawn.
    const url = page.url();
    await page.reload();
    await settle(page);
    expect(page.url()).toBe(url);
    await expect(page.getByText("JOB ROT-0001")).toBeVisible();

    // The receipts are rows: the job it read, and the tool that read it.
    await page.getByRole("button", { name: /see what it used/ }).click();
    await page.getByRole("tab", { name: "Sources" }).click();
    await expect(page.getByRole("tabpanel").getByText(/ROT-0001/)).toBeVisible();
    await page.getByRole("tab", { name: "Receipts" }).click();
    await expect(page.getByRole("tabpanel").getByText("Rotary")).toBeVisible();
    await expect(page.getByRole("tabpanel").getByText("claude-opus-5-5")).toBeVisible();
  });

  test("switching to Plan is kept, and /plan is an explicit command", async ({ page }) => {
    await signIn(page, STAFF, "/chat");
    await settle(page);
    await newConversation(page);
    await settle(page);

    await page.getByRole("button", { name: "Plan" }).click();
    await expect(page.getByRole("button", { name: "Plan", pressed: true })).toBeVisible();
    await page.reload();
    await settle(page);
    await expect(page.getByRole("button", { name: "Plan", pressed: true })).toBeVisible();

    await page.getByLabel("Message").fill("/");
    await expect(page.getByRole("list", { name: "Commands" })).toBeVisible();
    await page.getByRole("button", { name: /\/review/ }).click();
    await expect(page.getByText(/Reviews the selected context/)).toBeVisible();
  });
});

test.describe("a conversation about a repository", () => {
  test.beforeEach(resetSignInState);
  test.skip(!githubMocked, "Needs the Anthropic and GitHub stand-ins; see the note at the top.");

  test.beforeEach(async () => {
    // A previous run's link would otherwise hold the repository.
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query("update repositories set unlinked_at = now() where external_id = $1 and unlinked_at is null", [MOCK_REPOSITORY_ID]);
    await db.end();
  });

  test("link a repository, pick a branch, browse it, @ a file, and see the commit the answer read", async ({ page }) => {
    await signIn(page, STAFF, "/chat");
    await settle(page);
    await page.getByRole("combobox", { name: "Client" }).selectOption({ label: "Rotary" });
    await page.getByLabel(/Reason/).fill("Reviewing the storefront for the e2e test");
    await page.getByRole("button", { name: "Open for 30 minutes" }).click();
    await newConversation(page);
    await settle(page);

    // Link it to Rotary from the list the GitHub App can see.
    await page.getByText(/Manage repositories for Rotary/).click();
    const linkRow = page.getByRole("listitem").filter({ hasText: "10xid-com/storefront" });
    await linkRow.getByRole("button", { name: "Link" }).click();
    await settle(page);

    // Choose it, on a feature branch.
    await page.getByRole("combobox", { name: "Repository" }).selectOption({ label: "10xid-com/storefront" });
    const branch = page.getByRole("combobox", { name: "Branch" });
    await expect(branch.locator("option", { hasText: "feature/checkout" })).toHaveCount(1);
    await branch.selectOption("feature/checkout");
    await page.getByRole("button", { name: "Use for this conversation" }).click();
    await settle(page);
    await expect(page.getByText(/Answers read this branch/)).toBeVisible();

    // Browse: secrets are listed as such; changed files are marked.
    await page.getByRole("tab", { name: "Repository" }).click();
    const files = page.getByRole("list", { name: "Repository files" });
    await expect(files.getByText("src/")).toBeVisible();
    await files.getByRole("button", { name: /src\// }).click();
    await expect(files.getByRole("listitem").filter({ hasText: "app.ts" }).getByText("modified")).toBeVisible();

    // @ picks a file by name.
    await page.getByLabel("Message").fill("What does greet say? @src/ap");
    await page.getByRole("list", { name: "Files" }).getByRole("button", { name: "@src/app.ts" }).click();
    await expect(page.getByText(/Adds to context: src\/app\.ts/)).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page.getByText(/greet\(\) says "Welcome"/)).toBeVisible();
    await expect(page.getByText(/10xid-com\/storefront@feature\/checkout/)).toBeVisible();

    // After a refresh, from the database: the file is in context, and the
    // receipt names the repository, branch and commit.
    await page.reload();
    await settle(page);
    await page.getByRole("button", { name: /see what it used/ }).click();
    await page.getByRole("tab", { name: "Sources" }).click();
    await expect(page.getByRole("tabpanel").getByText(/src\/app\.ts L1–4 @ [0-9a-f]{7}/).first()).toBeVisible();
    await page.getByRole("tab", { name: "Receipts" }).click();
    await expect(page.getByRole("tabpanel").getByText(/10xid-com\/storefront · feature\/checkout @ [0-9a-f]{7}/)).toBeVisible();
    await page.getByRole("tab", { name: "Context" }).click();
    await expect(page.getByRole("tabpanel").getByText("src/app.ts", { exact: true })).toBeVisible();
  });
});
