import { expect, test } from "@playwright/test";
import { resetSignInState, signIn } from "./helpers";

/**
 * The staff chat.
 *
 * What is checked here is the part a unit test cannot see: who lands on it
 * and who is kept out. None of it calls a model, so the suite needs neither a
 * key nor OpenRouter's free allowance. Reading OpenRouter's stream and falling
 * over between models is test/chat.test.ts.
 */

const CLIENT = "jane@rotary.test";
const STAFF = "paolo@brandingcentres.test";

test.describe("chat", () => {
  test.beforeEach(resetSignInState);

  test("staff land on the chat after signing in", async ({ page }) => {
    await signIn(page, STAFF, "/");
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByRole("link", { name: "Chat" })).toBeVisible();
  });

  test("a client is sent to their dashboard and refused by the endpoint", async ({
    page,
  }) => {
    await signIn(page, CLIENT, "/");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("link", { name: "Chat" })).toHaveCount(0);

    await page.goto("/chat");
    await expect(page).toHaveURL(/\/dashboard/);

    // The endpoint, asked directly with the client's own cookie.
    const res = await page.request.post("/api/chat", {
      data: {
        model: "qwen/qwen3.8-27b:free",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(res.status()).toBe(403);
  });

  test("signed out, the endpoint answers 401 rather than a sign-in page", async ({
    request,
  }) => {
    const res = await request.post("/api/chat", {
      data: { model: "qwen/qwen3.8-27b:free", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status()).toBe(401);
  });
});
