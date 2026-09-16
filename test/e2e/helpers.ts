import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { Client } from "pg";

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

/** Complete the whole sign-in flow on the login host. */
export async function signIn(page: Page, email: string, next = "/") {
  await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a code" }).click();

  await page.waitForURL(/\/auth\/verify/);
  const code = await latestCodeFor(email);

  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));
}
