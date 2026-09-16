# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cross-domain.spec.ts >> cross-domain sign-in >> signed in at the login host, a client domain needs no second prompt
- Location: test/e2e/cross-domain.spec.ts:47:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Signed in as')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText('Signed in as') with timeout 10000ms
  - waiting for getByText('Signed in as')

```

```yaml
- banner:
  - link "10XiD Portal":
    - /url: /jobs
  - navigation:
    - link "Jobs":
      - /url: /jobs
  - text: jane@rotary.test
  - button "Sign out"
- main:
  - heading "Jobs" [level=1]
  - paragraph: Work in flight, both directions.
  - text: 10 jobs
  - list:
    - listitem:
      - link "ROT-0010 Spring drive banner f210cb49 → us open —":
        - /url: /jobs/01a0ab47-8db3-702c-8c3e-e4153780b5b2
    - listitem:
      - link "ROT-0009 Spring drive banner bc7e680f → us open —":
        - /url: /jobs/01a0ab43-a9b6-7754-9f8e-fa3e1578cf3b
    - listitem:
      - link "ROT-0008 Spring drive banner cf4c3d04 → us open —":
        - /url: /jobs/01a0ab40-ada9-7f78-9ab8-237a8daf9b38
    - listitem:
      - link "ROT-0007 Spring drive banner f55fa3af → us open —":
        - /url: /jobs/01a0ab3e-3e3f-7270-836a-08bac76b9732
    - listitem:
      - link "ROT-0006 Spring drive banner 7ff76f26 → us open —":
        - /url: /jobs/01a0ab3a-c27c-78cd-b46b-3aba5388ca34
    - listitem:
      - link "ROT-0005 New banner for the spring drive → us open —":
        - /url: /jobs/01a0ab39-c6ac-7223-a6dc-b43529d0c69f
    - listitem:
      - link "ROT-0004 New banner for the spring drive → us open —":
        - /url: /jobs/01a0ab39-271c-7744-bc5c-5fc31bac3e0b
    - listitem:
      - link "ROT-0003 New banner for the spring drive → us open —":
        - /url: /jobs/01a0ab38-2d41-7a36-9212-c5ff61870284
    - listitem:
      - link "ROT-0002 Club pin proof — second round → client in progress —":
        - /url: /jobs/01a0ab05-7c11-7104-bef2-62e8508918d2
    - listitem:
      - link "ROT-0001 District 7070 banner artwork → us open —":
        - /url: /jobs/01a0ab05-7c0f-71f6-a03e-6e31e8f2749f
  - heading "Send a new job" [level=2]
  - textbox "Job title":
    - /placeholder: What needs doing?
  - combobox "Direction":
    - option "We are sending it in" [selected]
    - option "We are sending it out"
  - textbox "Due date"
  - button "Send"
```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | import { resetSignInState, signIn } from "./helpers";
  3   | 
  4   | /**
  5   |  * Phase 1's first risky claim: sign in once at the login host, then land
  6   |  * already signed in on a site at a GENUINELY DIFFERENT registrable domain,
  7   |  * with no second prompt.
  8   |  *
  9   |  * portal-a.test and portal-b.test are different registrable domains. Two
  10  |  * subdomains of one domain would prove nothing — sharing a cookie between
  11  |  * those is ordinary browser behaviour, not cross-domain sign-in.
  12  |  */
  13  | 
  14  | const PRIMARY = "http://login.portal-a.test:3000";
  15  | const ROTARY = "http://rotary.portal-b.test:3000";
  16  | const NORTHSTAR = "http://northstar.portal-b.test:3000";
  17  | 
  18  | const CLIENT = "jane@rotary.test";
  19  | 
  20  | /**
  21  |  * Record every document request, so the redirect chain itself is the evidence.
  22  |  *
  23  |  * Deliberately not `framenavigated`: that fires only for the URL the browser
  24  |  * finally commits to, after the redirects have been followed. Every
  25  |  * intermediate hop — including the one carrying the ticket — is invisible to
  26  |  * it, which makes it useless for proving what actually happened in between.
  27  |  */
  28  | function recordHops(page: Page) {
  29  |   const hops: string[] = [];
  30  |   page.on("request", (req) => {
  31  |     if (req.resourceType() === "document") hops.push(req.url());
  32  |   });
  33  |   return hops;
  34  | }
  35  | 
  36  | test.describe("cross-domain sign-in", () => {
  37  |   test.beforeEach(resetSignInState);
  38  | 
  39  |   test("the two hosts really are different registrable domains", async () => {
  40  |     const reg = (u: string) =>
  41  |       new URL(u).hostname.split(".").slice(-2).join(".");
  42  |     expect(reg(PRIMARY)).toBe("portal-a.test");
  43  |     expect(reg(ROTARY)).toBe("portal-b.test");
  44  |     expect(reg(PRIMARY)).not.toBe(reg(ROTARY));
  45  |   });
  46  | 
  47  |   test("signed in at the login host, a client domain needs no second prompt", async ({
  48  |     page,
  49  |   }) => {
  50  |     await signIn(page, CLIENT);
> 51  |     await expect(page.getByText("Signed in as")).toBeVisible();
      |                                                  ^ Error: expect(locator).toBeVisible() failed
  52  | 
  53  |     const hops = recordHops(page);
  54  |     const started = Date.now();
  55  |     await page.goto(ROTARY + "/");
  56  |     await page.waitForLoadState("load");
  57  |     const elapsed = Date.now() - started;
  58  | 
  59  |     // Landed on the client domain, signed in, with no form in between.
  60  |     expect(new URL(page.url()).host).toBe("rotary.portal-b.test:3000");
  61  |     await expect(page.getByText("Signed in as")).toBeVisible();
  62  |     await expect(page.getByLabel("Email")).toHaveCount(0);
  63  |     await expect(page.getByLabel("Six-digit code")).toHaveCount(0);
  64  | 
  65  |     // The person never saw a sign-in page during the handoff either.
  66  |     expect(hops.some((h) => h.includes("/auth/login"))).toBe(false);
  67  |     expect(hops.some((h) => h.includes("/auth/verify"))).toBe(false);
  68  | 
  69  |     console.log(`\n  handoff round trip: ${elapsed}ms`);
  70  |     console.log(`  hops (${hops.length}):`);
  71  |     for (const h of hops) console.log(`    ${h.replace("http://", "")}`);
  72  | 
  73  |     expect(elapsed).toBeLessThan(5000);
  74  |   });
  75  | 
  76  |   test("a cold visit with no session anywhere ends at the login host", async ({
  77  |     page,
  78  |   }) => {
  79  |     const hops = recordHops(page);
  80  |     await page.goto(ROTARY + "/");
  81  |     await page.waitForLoadState("load");
  82  | 
  83  |     // Sign-in happens on the login host and nowhere else.
  84  |     expect(new URL(page.url()).host).toBe("login.portal-a.test:3000");
  85  |     await expect(page.getByText("Welcome back")).toBeVisible();
  86  |     expect(hops.some((h) => h.includes("rotary.portal-b.test"))).toBe(true);
  87  |   });
  88  | 
  89  |   test("signing out at the login host ends the session on the other domain", async ({
  90  |     page,
  91  |   }) => {
  92  |     await signIn(page, CLIENT);
  93  |     await page.goto(ROTARY + "/");
  94  |     await expect(page.getByText("Signed in as")).toBeVisible();
  95  | 
  96  |     await page.goto(PRIMARY + "/");
  97  |     await page.getByRole("button", { name: "Sign out everywhere" }).click();
  98  |     await page.waitForURL(/\/auth\/login/);
  99  |     const signedOutAt = Date.now();
  100 | 
  101 |     // Poll the other domain until it stops treating this person as signed in.
  102 |     let stoppedAt = 0;
  103 |     for (let i = 0; i < 40; i++) {
  104 |       await page.goto(ROTARY + "/");
  105 |       await page.waitForLoadState("load");
  106 |       const stillIn = await page
  107 |         .getByText("Signed in as")
  108 |         .isVisible()
  109 |         .catch(() => false);
  110 |       if (!stillIn) {
  111 |         stoppedAt = Date.now();
  112 |         break;
  113 |       }
  114 |       await page.waitForTimeout(250);
  115 |     }
  116 | 
  117 |     expect(stoppedAt).toBeGreaterThan(0);
  118 |     const lag = stoppedAt - signedOutAt;
  119 |     console.log(
  120 |       `\n  other domain stopped honouring the session after ${lag}ms ` +
  121 |         `(one request; the session row is revoked, so there is no token to outlive it)`,
  122 |     );
  123 |     expect(lag).toBeLessThan(3000);
  124 |   });
  125 | 
  126 |   test("a spent ticket cannot be used again", async ({ page, context }) => {
  127 |     await signIn(page, CLIENT);
  128 | 
  129 |     // Capture the callback URL, ticket and all, as it goes past.
  130 |     let callbackUrl = "";
  131 |     page.on("request", (req) => {
  132 |       const u = req.url();
  133 |       if (req.resourceType() === "document" && u.includes("/auth/sso/callback")) {
  134 |         callbackUrl = u;
  135 |       }
  136 |     });
  137 | 
  138 |     await page.goto(ROTARY + "/");
  139 |     await expect(page.getByText("Signed in as")).toBeVisible();
  140 |     expect(callbackUrl).toContain("ticket=");
  141 | 
  142 |     // Replay it with no state cookie and no session: must be refused.
  143 |     await context.clearCookies();
  144 |     await page.goto(callbackUrl);
  145 |     await page.waitForLoadState("load");
  146 |     expect(page.url()).toContain("/auth/sso/failed");
  147 |   });
  148 | 
  149 |   test("a ticket for one client domain is worthless at another", async ({
  150 |     page,
  151 |   }) => {
```