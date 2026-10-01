import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { Client } from "pg";
import { createHmac } from "node:crypto";

const SINK = process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";

/**
 * Read the most recent sign-in code issued to an address.
 *
 * In development, codes are appended to a file instead of being emailed. This
 * reads that file rather than exposing an endpoint that hands out codes —
 * a "development only" backdoor is the kind of thing that survives into
 * production, and this cannot.
 */
export async function latestCodeFor(email: string): Promise<string> {
  const contents = await readFile(SINK, "utf8").catch(() => "");
  const matches = contents
    .split("\n")
    .filter((l) => l.includes(`\t${email.toLowerCase()}\t`))
    .map((l) => l.split("\t")[2]?.trim())
    .filter(Boolean);

  const code = matches.at(-1);
  if (!code) {
    throw new Error(
      `No sign-in code was issued to ${email}. Is the dev server writing to ${SINK}?`,
    );
  }
  return code;
}

/**
 * Clear per-person auth state between tests.
 *
 * Two independent reasons, both found by tests failing:
 *
 *  - Requesting a code is rate limited per address, and a global setup hook
 *    runs once per invocation rather than once per browser, so the second
 *    browser inherited the first's spent allowance.
 *  - A staff grant outlives the test that created it, so a later test found
 *    staff still acting on a client and saw a scoped view where it expected
 *    the overview.
 *
 * Resetting the state is the right fix for both. Relaxing the rate limit for
 * tests would leave the shipped limit untested, and expiring grants faster
 * would change the behaviour being tested.
 */
export async function resetSignInState() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(
    "truncate sign_in_codes, sso_tickets, staff_grants, sessions cascade",
  );
  // Clear staff authenticator enrolment too, so each test walks the full
  // second-factor path rather than depending on a secret a previous test set.
  await db.query(
    "update users set totp_secret = null, totp_confirmed_at = null",
  );
  await db.end();
}

/**
 * Assert the portal is showing, whatever the landing page happens to be.
 *
 * Deliberately not a copy of some sentence on the page: the landing page has
 * already been replaced once, which silently broke every test that asserted its
 * wording. The portal chrome is the stable signal that someone is signed in.
 */
export async function expectSignedIn(page: Page) {
  await page.waitForSelector("text=10XiD Portal", { timeout: 15_000 });
}

/**
 * The page's own alert, not Next's.
 *
 * Once a page hydrates, Next adds `#__next-route-announcer__` — a visually
 * hidden role="alert" that reads each new page's title to screen readers — so
 * a bare getByRole("alert") finds two and fails strict mode. Every alert a
 * test means is one the page drew.
 */
export function pageAlert(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/**
 * Open the account menu (the Pin), where Sign out and the signed-in address
 * live. A no-op when it is already open, so callers need not track it.
 */
export async function openAccountMenu(page: Page) {
  const pin = page.getByRole("button", { name: "Account and organization" });
  if ((await pin.getAttribute("aria-expanded")) !== "true") await pin.click();
  await page.getByRole("menu").waitFor();
}

/**
 * The session row the server actually stored.
 *
 * Better than reading the caps off a page: it asserts the policy that will be
 * enforced, not a string that happened to be rendered next to it.
 */
export async function latestSessionFor(email: string) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(
    `select s.idle_seconds, s.absolute_expires_at, s.role_at_creation,
            s.issued_for_host, s.revoked_at
       from sessions s join users u on u.id = s.user_id
      where u.email = $1
      order by s.created_at desc limit 1`,
    [email.toLowerCase()],
  );
  await db.end();
  return rows[0] ?? null;
}

/**
 * Push a person's newest session back in time.
 *
 * The only way to test "you are not logged out while you are away" without
 * waiting out the clock. It moves `last_seen_at` and `created_at`, which are
 * the two values every expiry decision is made from, so the server sees a
 * session that has genuinely been idle for that long.
 */
export async function ageNewestSession(email: string, days: number) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(
    `update sessions
        set last_seen_at = now() - ($2 || ' days')::interval,
            created_at   = now() - ($2 || ' days')::interval
      where id = (
        select s.id from sessions s
          join users u on u.id = s.user_id
         where u.email = $1 and s.revoked_at is null
         order by s.created_at desc limit 1
      )`,
    [email.toLowerCase(), String(days)],
  );
  await db.end();
}

/** Look up seeded ids, so tests attack real rows rather than invented ones. */
export async function seededIds() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(`
    select
      (select id from jobs where ref = 'ROT-0001') as rotary_job,
      (select id from jobs where ref = 'NOR-0001') as northstar_job,
      (select title from jobs where ref = 'NOR-0001') as northstar_title
  `);
  await db.end();
  return rows[0] as {
    rotary_job: string;
    northstar_job: string;
    northstar_title: string;
  };
}

/**
 * Compute the current TOTP code from a base32 secret.
 *
 * Reimplemented here rather than imported from lib/auth/totp, which is marked
 * server-only and throws outside a server context. Keeping the test's own
 * implementation also means the code the app accepts is checked against an
 * independent calculation rather than against itself.
 */
export function totpCode(secretBase32: string, at = Date.now()): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/[^A-Z2-7]/gi, "").toUpperCase()) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Clear the staff second factor, if this sign-in landed on it.
 *
 * Staff must pass a second step because a staff session reaches every client.
 * The enrolment screen shows the setup key, so the test reads it from the page
 * exactly as a person would, then produces a code from it.
 */
export async function passSecondFactor(page: Page): Promise<string | null> {
  await settle(page);
  if (!page.url().includes("/auth/2fa")) return null;

  const start = page.getByRole("button", { name: "Start setup" });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
    await page.waitForURL(/\/auth\/2fa/);
  }

  const key = (await page.getByText(/^[A-Z2-7 ]{20,}$/).first().innerText())
    .replace(/\s+/g, "");

  await page.getByLabel("Six-digit code").fill(totpCode(key));
  await page.getByRole("button", { name: /Confirm and continue|Continue/ }).click();

  // First enrolment now lands on the recovery codes, because confirming is the
  // moment the emailed code stops working for this account. Acknowledge them so
  // the rest of the suite carries on to wherever it was heading.
  await page.waitForURL(
    (u) => !u.pathname.startsWith("/auth/") || u.pathname === "/auth/recovery-codes",
  );
  if (page.url().includes("/auth/recovery-codes")) {
    await page.getByRole("button", { name: /I have saved these/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));
  }

  return key;
}

/**
 * Enrol an authenticator through the interface, as a person would, and come
 * back with the things only shown once.
 *
 * Done through the screens rather than by writing an encrypted secret into the
 * database directly: the secret is stored encrypted with a key from the
 * environment, so a test that wrote its own would be testing its own
 * encryption rather than the application's.
 */
export async function enrolAuthenticator(
  page: Page,
  email: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/auth\/verify/);
  await page.getByLabel("Six-digit code").fill(await latestCodeFor(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/auth\/2fa/);

  const start = page.getByRole("button", { name: "Start setup" });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
    await page.waitForURL(/\/auth\/2fa/);
  }

  const secret = (await page.getByText(/^[A-Z2-7 ]{20,}$/).first().innerText())
    .replace(/\s+/g, "");

  await page.getByLabel("Six-digit code").fill(totpCode(secret));
  await page.getByRole("button", { name: /Confirm and continue/ }).click();
  await page.waitForURL(/\/auth\/recovery-codes/);

  const recoveryCodes = await page
    .locator("li.font-mono")
    .allInnerTexts()
    .then((texts) => texts.map((t) => t.trim()).filter(Boolean));

  await page.getByRole("button", { name: /I have saved these/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));

  return { secret, recoveryCodes };
}

/** End the session without clearing the enrolment, unlike resetSignInState. */
export async function signOut(page: Page) {
  await openAccountMenu(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/auth\/login/);
}

/** Complete the whole sign-in flow on the login host. */
export async function signIn(page: Page, email: string, next = "/") {
  await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL(/\/auth\/verify/);
  const code = await latestCodeFor(email);

  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/auth/") || url.pathname === "/auth/2fa",
  );
  await settle(page);
  await passSecondFactor(page);
}

/**
 * Let a chain of redirects finish before reading where it ended.
 *
 * On a hydrated page a server action's redirect is followed by the client
 * router, and the address bar can show an intermediate stop — `/chat`, say, on
 * its way to `/auth/2fa?next=/chat` — for a moment. A test that reads
 * page.url() in that moment decides on the wrong page.
 */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
}
