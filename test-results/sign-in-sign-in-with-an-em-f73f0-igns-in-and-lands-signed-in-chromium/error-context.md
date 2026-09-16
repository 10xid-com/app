# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sign-in.spec.ts >> sign in with an emailed code >> a known person signs in and lands signed in
- Location: test/e2e/sign-in.spec.ts:17:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.waitForURL: Test timeout of 60000ms exceeded.
=========================== logs ===========================
waiting for navigation until "load"
============================================================
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - heading "This page couldn’t load" [level=1] [ref=e6]
    - paragraph [ref=e7]: A server error occurred. Reload to try again.
    - button "Reload" [ref=e10] [cursor=pointer]
  - paragraph [ref=e11]: ERROR 2888375195
```

# Test source

```ts
  28  |   }
  29  |   return code;
  30  | }
  31  | 
  32  | /**
  33  |  * Clear per-person auth state between tests.
  34  |  *
  35  |  * Two independent reasons, both found by tests failing:
  36  |  *
  37  |  *  - Requesting a code is rate limited per address, and a global setup hook
  38  |  *    runs once per invocation rather than once per browser, so the second
  39  |  *    browser inherited the first's spent allowance.
  40  |  *  - A staff grant outlives the test that created it, so a later test found
  41  |  *    staff still acting on a client and saw a scoped view where it expected
  42  |  *    the overview.
  43  |  *
  44  |  * Resetting the state is the right fix for both. Relaxing the rate limit for
  45  |  * tests would leave the shipped limit untested, and expiring grants faster
  46  |  * would change the behaviour being tested.
  47  |  */
  48  | export async function resetSignInState() {
  49  |   try {
  50  |     process.loadEnvFile(".env.local");
  51  |   } catch {
  52  |     /* CI supplies the environment */
  53  |   }
  54  |   const db = new Client({ connectionString: process.env.DATABASE_URL });
  55  |   await db.connect();
  56  |   await db.query(
  57  |     "truncate sign_in_codes, sso_tickets, staff_grants, sessions cascade",
  58  |   );
  59  |   await db.end();
  60  | }
  61  | 
  62  | /**
  63  |  * Assert the portal is showing, whatever the landing page happens to be.
  64  |  *
  65  |  * Deliberately not a copy of some sentence on the page: the landing page has
  66  |  * already been replaced once, which silently broke every test that asserted its
  67  |  * wording. The portal chrome is the stable signal that someone is signed in.
  68  |  */
  69  | export async function expectSignedIn(page: Page) {
  70  |   await page.waitForSelector("text=10XiD Portal", { timeout: 15_000 });
  71  | }
  72  | 
  73  | /**
  74  |  * The session row the server actually stored.
  75  |  *
  76  |  * Better than reading the caps off a page: it asserts the policy that will be
  77  |  * enforced, not a string that happened to be rendered next to it.
  78  |  */
  79  | export async function latestSessionFor(email: string) {
  80  |   try {
  81  |     process.loadEnvFile(".env.local");
  82  |   } catch {
  83  |     /* CI supplies the environment */
  84  |   }
  85  |   const db = new Client({ connectionString: process.env.DATABASE_URL });
  86  |   await db.connect();
  87  |   const { rows } = await db.query(
  88  |     `select s.idle_seconds, s.absolute_expires_at, s.role_at_creation,
  89  |             s.issued_for_host, s.revoked_at
  90  |        from sessions s join users u on u.id = s.user_id
  91  |       where u.email = $1
  92  |       order by s.created_at desc limit 1`,
  93  |     [email.toLowerCase()],
  94  |   );
  95  |   await db.end();
  96  |   return rows[0] ?? null;
  97  | }
  98  | 
  99  | /** Look up seeded ids, so tests attack real rows rather than invented ones. */
  100 | export async function seededIds() {
  101 |   try {
  102 |     process.loadEnvFile(".env.local");
  103 |   } catch {
  104 |     /* CI supplies the environment */
  105 |   }
  106 |   const db = new Client({ connectionString: process.env.DATABASE_URL });
  107 |   await db.connect();
  108 |   const { rows } = await db.query(`
  109 |     select
  110 |       (select id from jobs where ref = 'ROT-0001') as rotary_job,
  111 |       (select id from jobs where ref = 'NOR-0001') as northstar_job,
  112 |       (select title from jobs where ref = 'NOR-0001') as northstar_title
  113 |   `);
  114 |   await db.end();
  115 |   return rows[0] as {
  116 |     rotary_job: string;
  117 |     northstar_job: string;
  118 |     northstar_title: string;
  119 |   };
  120 | }
  121 | 
  122 | /** Complete the whole sign-in flow on the login host. */
  123 | export async function signIn(page: Page, email: string, next = "/") {
  124 |   await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  125 |   await page.getByLabel("Email").fill(email);
  126 |   await page.getByRole("button", { name: "Send me a code" }).click();
  127 | 
> 128 |   await page.waitForURL(/\/auth\/verify/);
      |              ^ Error: page.waitForURL: Test timeout of 60000ms exceeded.
  129 |   const code = await latestCodeFor(email);
  130 | 
  131 |   await page.getByLabel("Six-digit code").fill(code);
  132 |   await page.getByRole("button", { name: "Sign in" }).click();
  133 |   await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));
  134 | }
  135 | 
```