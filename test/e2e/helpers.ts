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
export async function passSecondFactor(page: Page) {
  if (!page.url().includes("/auth/2fa")) return;

  const start = page.getByRole("button", { name: "Start setup" });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
    await page.waitForURL(/\/auth\/2fa/);
  }

  const key = (await page.getByText(/^[A-Z2-7 ]{20,}$/).first().innerText())
    .replace(/\s+/g, "");

  await page.getByLabel("Six-digit code").fill(totpCode(key));
  await page.getByRole("button", { name: /Confirm and continue|Continue/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));
}

/** Complete the whole sign-in flow on the login host. */
export async function signIn(page: Page, email: string, next = "/") {
  await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a code" }).click();

  await page.waitForURL(/\/auth\/verify/);
  const code = await latestCodeFor(email);

  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/auth/") || url.pathname === "/auth/2fa",
  );
  await passSecondFactor(page);
}
