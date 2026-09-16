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
 * Clear issued sign-in codes between tests.
 *
 * Requesting a code is rate limited per address, and a global setup hook runs
 * once per invocation rather than once per browser — so without this, the
 * second browser inherits the first browser's spent allowance and every test
 * that signs in is redirected to the rate-limit page.
 *
 * Resetting the state is the right fix. Raising the limit for tests would mean
 * the limit nobody tests is the one that ships.
 */
export async function resetSignInState() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("truncate sign_in_codes cascade");
  await db.end();
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
