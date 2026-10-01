import type { Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { resetSignInState, settle, signIn } from "./helpers";
import { MOCK_ANTHROPIC_URL, startMockAnthropic } from "./mock-anthropic";

/**
 * The workspace, in a browser.
 *
 * Who gets in and who does not runs always. The grounded-answer tests need the
 * dev server pointed at the Anthropic stand-in (test/e2e/mock-anthropic.ts):
 *
 *   ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm run test:e2e
 *
 * Under that, everything except the model is real — the SDK, the job tools,
 * the database rows the receipts panel reads back after a refresh.
 */

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";
const mocked = process.env.ANTHROPIC_BASE_URL === MOCK_ANTHROPIC_URL;

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
test.beforeAll(async () => {
  if (mocked) mock = await startMockAnthropic();
});
test.afterAll(async () => {
  await new Promise((r) => (mock ? mock.close(r) : r(null)));
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
