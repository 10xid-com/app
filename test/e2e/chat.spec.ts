import { expect, test } from "@playwright/test";
import { resetSignInState, settle, signIn } from "./helpers";

/**
 * The staff chat.
 *
 * What is checked here is the part a unit test cannot see: who lands on it,
 * who is kept out, and that an answer from the server appears on screen under
 * the name of the model that gave it. The model itself is never called — the
 * browser's request to /api/chat is answered by the test — so the suite needs
 * neither a working key nor OpenRouter's free allowance. Reading OpenRouter's
 * stream and falling over between models is test/chat.test.ts.
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

  test("an answer appears and names the model that gave it", async ({ page }) => {
    test.skip(
      !process.env.OPENROUTER_API_KEY,
      "The box is drawn only once OPENROUTER_API_KEY is set; any value will do, it is never used.",
    );

    await signIn(page, STAFF, "/chat");
    await settle(page);

    let sent: { messages: { role: string; content: string }[] } | null = null;
    await page.route("**/api/chat", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          // As if Qwen was throttled and the server fell over to Gemma.
          "X-Chat-Model": "google/gemma-4-31b-it:free",
        },
        body: "Here is a draft.",
      });
    });

    await page.getByLabel("Message").fill("Draft a reply to Rotary");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Here is a draft.")).toBeVisible();
    // The screen names the model that answered, not the one that was picked.
    await expect(page.getByText("Gemma 4 31B", { exact: true })).toBeVisible();
    expect(sent!.messages).toEqual([{ role: "user", content: "Draft a reply to Rotary" }]);
  });

  test("a failure says why and puts the question back", async ({ page }) => {
    test.skip(!process.env.OPENROUTER_API_KEY, "As above.");

    await signIn(page, STAFF, "/chat");
    await settle(page);
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        status: 502,
        json: { error: "This free model is busy or today's free allowance is used up." },
      }),
    );

    await page.getByLabel("Message").fill("Summarise the brief");
    await page.keyboard.press("Enter");

    await expect(page.getByText("free allowance is used up")).toBeVisible();
    await expect(page.getByLabel("Message")).toHaveValue("Summarise the brief");
  });

  test("a model picked by hand that was busy is named as busy", async ({ page }) => {
    test.skip(!process.env.OPENROUTER_API_KEY, "As above.");

    await signIn(page, STAFF, "/chat");
    await settle(page);
    // Auto is the default; pick Qwen by hand, and have Gemma answer instead.
    await expect(page.getByLabel("Model")).toHaveValue("auto");
    await page.getByLabel("Model").selectOption("qwen/qwen3.8-27b:free");
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Chat-Model": "google/gemma-4-31b-it:free",
        },
        body: "An answer.",
      }),
    );

    await page.getByLabel("Message").fill("hello");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Gemma 4 31B · Qwen 3.8 27B was busy")).toBeVisible();
  });
});
