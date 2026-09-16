# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sign-in.spec.ts >> sign in with an emailed code >> an unknown address is told the same thing as a known one
- Location: test/e2e/sign-in.spec.ts:42:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Check your email')
Expected: visible
Error: strict mode violation: getByText('Check your email') resolved to 2 elements:
    1) <h1 class="text-xl font-semibold tracking-tight text-ink text-balance">Check your email</h1> aka getByRole('heading', { name: 'Check your email' })
    2) <div role="alert" aria-live="assertive" id="__next-route-announcer__">Check your email</div> aka locator('[id="__next-route-announcer__"]')

Call log:
  - Expect "toBeVisible" getByText('Check your email') with timeout 10000ms
  - waiting for getByText('Check your email')

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - alert [ref=e2]: Check your email
  - main [ref=e3]:
    - generic [ref=e4]:
      - generic [ref=e5]: 10XiD
      - generic [ref=e7]:
        - heading "Check your email" [level=1] [ref=e8]
        - paragraph [ref=e9]:
          - text: We sent a six-digit code to
          - strong [ref=e10]: nobody@nowhere.test
          - text: . It expires in ten minutes and works once.
        - generic [ref=e11]:
          - generic [ref=e12]:
            - generic [ref=e13]: Six-digit code
            - textbox "Six-digit code" [active] [ref=e14]:
              - /placeholder: "000000"
            - button "Sign in" [ref=e15]
          - paragraph [ref=e16]:
            - link "Use a different email, or request a new code" [ref=e17] [cursor=pointer]:
              - /url: /auth/login?next=%2F&email=nobody%40nowhere.test
      - paragraph [ref=e18]: Didn't arrive? Check spam, or request another code.
```

# Test source

```ts
  1   | import { expect, test } from "@playwright/test";
  2   | import {
  3   |   expectSignedIn,
  4   |   latestCodeFor,
  5   |   latestSessionFor,
  6   |   resetSignInState,
  7   |   signIn,
  8   | } from "./helpers";
  9   | 
  10  | const CLIENT = "jane@rotary.test";
  11  | const STRANGER = "nobody@nowhere.test";
  12  | 
  13  | test.describe("sign in with an emailed code", () => {
  14  |   // Each test starts with a clean rate-limit allowance. See resetSignInState.
  15  |   test.beforeEach(resetSignInState);
  16  | 
  17  |   test("a known person signs in and lands signed in", async ({ page }) => {
  18  |     await signIn(page, CLIENT);
  19  |     await expectSignedIn(page);
  20  |     await expect(page.getByText(CLIENT)).toBeVisible();
  21  |   });
  22  | 
  23  |   test("a client session carries the 30-day cap and no idle timeout", async ({
  24  |     page,
  25  |   }) => {
  26  |     await signIn(page, CLIENT);
  27  |     await expectSignedIn(page);
  28  | 
  29  |     // Asserted against the stored session, not against text on a page: these
  30  |     // are the limits that will actually be enforced.
  31  |     const session = await latestSessionFor(CLIENT);
  32  |     expect(session).not.toBeNull();
  33  |     expect(session.role_at_creation).toBe("client");
  34  |     expect(session.idle_seconds).toBeNull();
  35  | 
  36  |     const days =
  37  |       (new Date(session.absolute_expires_at).getTime() - Date.now()) / 86_400_000;
  38  |     expect(days).toBeGreaterThan(29.5);
  39  |     expect(days).toBeLessThan(30.5);
  40  |   });
  41  | 
  42  |   test("an unknown address is told the same thing as a known one", async ({
  43  |     page,
  44  |   }) => {
  45  |     // Enumeration resistance: the form must not reveal who has an account.
  46  |     await page.goto("/auth/login");
  47  |     await page.getByLabel("Email").fill(STRANGER);
  48  |     await page.getByRole("button", { name: "Send me a code" }).click();
  49  | 
  50  |     await page.waitForURL(/\/auth\/verify/);
> 51  |     await expect(page.getByText("Check your email")).toBeVisible();
      |                                                      ^ Error: expect(locator).toBeVisible() failed
  52  | 
  53  |     // ...and no code was actually issued to it.
  54  |     await expect(latestCodeFor(STRANGER)).rejects.toThrow(/No sign-in code/);
  55  |   });
  56  | 
  57  |   test("a wrong code is refused", async ({ page }) => {
  58  |     await page.goto("/auth/login");
  59  |     await page.getByLabel("Email").fill(CLIENT);
  60  |     await page.getByRole("button", { name: "Send me a code" }).click();
  61  |     await page.waitForURL(/\/auth\/verify/);
  62  | 
  63  |     await page.getByLabel("Six-digit code").fill("000000");
  64  |     await page.getByRole("button", { name: "Sign in" }).click();
  65  | 
  66  |     await expect(page.getByRole("alert")).toContainText("did not work");
  67  |   });
  68  | 
  69  |   test("a code works once and only once", async ({ page, context }) => {
  70  |     await page.goto("/auth/login");
  71  |     await page.getByLabel("Email").fill(CLIENT);
  72  |     await page.getByRole("button", { name: "Send me a code" }).click();
  73  |     await page.waitForURL(/\/auth\/verify/);
  74  | 
  75  |     const code = await latestCodeFor(CLIENT);
  76  |     await page.getByLabel("Six-digit code").fill(code);
  77  |     await page.getByRole("button", { name: "Sign in" }).click();
  78  |     await expectSignedIn(page);
  79  | 
  80  |     // Same code, fresh browser state: must be rejected.
  81  |     await context.clearCookies();
  82  |     await page.goto("/auth/verify?email=" + encodeURIComponent(CLIENT));
  83  |     await page.getByLabel("Six-digit code").fill(code);
  84  |     await page.getByRole("button", { name: "Sign in" }).click();
  85  | 
  86  |     await expect(page.getByRole("alert")).toContainText("did not work");
  87  |   });
  88  | 
  89  |   test("repeated code requests are rate limited", async ({ page }) => {
  90  |     // A dedicated address, because the limit is per address and this test
  91  |     // deliberately exhausts it.
  92  |     const email = "ratelimit@rotary.test";
  93  | 
  94  |     let sawLimit = false;
  95  |     for (let i = 0; i < 7; i++) {
  96  |       await page.goto("/auth/login");
  97  |       await page.getByLabel("Email").fill(email);
  98  |       await page.getByRole("button", { name: "Send me a code" }).click();
  99  |       await page.waitForURL(/\/auth\/(verify|login)/);
  100 |       if (page.url().includes("error=rate")) {
  101 |         sawLimit = true;
  102 |         break;
  103 |       }
  104 |     }
  105 | 
  106 |     expect(sawLimit).toBe(true);
  107 |     await expect(page.getByRole("alert")).toContainText("Too many codes");
  108 |   });
  109 | 
  110 |   test("signing out ends the session", async ({ page }) => {
  111 |     await signIn(page, CLIENT);
  112 |     await expectSignedIn(page);
  113 |     await page.getByRole("button", { name: "Sign out" }).click();
  114 |     await page.waitForURL(/\/auth\/login/);
  115 | 
  116 |     // Going back to a protected page must not restore it.
  117 |     await page.goto("/");
  118 |     await expect(page).toHaveURL(/\/auth\/login/);
  119 |   });
  120 | });
  121 | 
```