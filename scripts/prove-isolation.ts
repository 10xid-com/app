import { chromium } from "@playwright/test";
import { Client } from "pg";
import { readFile } from "node:fs/promises";

/**
 * A real URL-guessing attempt, printed as a transcript.
 *
 * The automated tests assert this, but an assertion is a claim about a claim.
 * This signs in as an actual client through the actual sign-in form, then asks
 * for another client's job by its exact real id, and prints what came back —
 * status line, and whether a single byte of the other client's data appears.
 *
 *   npm run prove
 */

const CHROMIUM =
  process.env.E2E_CHROMIUM_PATH ??
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PRIMARY = process.env.E2E_PRIMARY_HOST ?? "login.portal-a.test:3000";
const SINK = process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";

const VICTIM = "jane@rotary.test";

function line(label = "") {
  console.log(label ? `\n── ${label} ${"─".repeat(Math.max(0, 62 - label.length))}` : "─".repeat(66));
}

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("truncate sign_in_codes cascade");
  const { rows } = await db.query(`
    select
      (select id    from jobs where ref = 'ROT-0001') as mine,
      (select id    from jobs where ref = 'NOR-0001') as theirs,
      (select title from jobs where ref = 'NOR-0001') as their_title
  `);
  await db.end();
  const { mine, theirs, their_title } = rows[0];

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage();
  const base = `http://${PRIMARY}`;

  line("signing in as a real client");
  console.log(`  ${VICTIM}`);
  await page.goto(`${base}/auth/login?next=%2Fjobs`);
  await page.getByLabel("Email").fill(VICTIM);
  // The sign-in button was renamed to "Continue" in d982641, when signing up
  // was separated from signing in. This selector was never updated, so the
  // proof has been failing on a 30-second timeout ever since rather than
  // proving anything. Only the selector changes here — every assertion below
  // is untouched.
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/auth\/verify/);

  const log = await readFile(SINK, "utf8").catch(() => "");
  const code = log
    .split("\n")
    .filter((l) => l.includes(`\t${VICTIM}\t`))
    .map((l) => l.split("\t")[2]?.trim())
    .filter(Boolean)
    .at(-1)!;

  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/jobs/);
  console.log("  signed in, real session cookie held by the browser");

  line("control: their OWN job, so we know the route works");
  const ok = await page.request.get(`${base}/jobs/${mine}`);
  console.log(`  GET /jobs/${mine}`);
  console.log(`  HTTP ${ok.status()} ${ok.statusText()}`);
  console.log(`  contains "ROT-0001": ${(await ok.text()).includes("ROT-0001")}`);

  line("the attempt: another client's job, by its exact real id");
  const attempt = await page.request.get(`${base}/jobs/${theirs}`);
  const body = await attempt.text();
  console.log(`  GET /jobs/${theirs}`);
  console.log(`  HTTP ${attempt.status()} ${attempt.statusText()}`);
  console.log(`  contains "NOR-0001":        ${body.includes("NOR-0001")}`);
  console.log(`  contains their job title:   ${body.includes(their_title)}`);
  console.log(`  bytes of their data leaked: ${body.includes(their_title) ? "SOME" : "0"}`);

  line("an id that never existed, for comparison");
  const ghost = await page.request.get(
    `${base}/jobs/00000000-0000-4000-8000-000000000000`,
  );
  console.log(`  HTTP ${ghost.status()} ${ghost.statusText()}`);
  console.log(
    `\n  Same status for a real job and an imaginary one: ${
      attempt.status() === ghost.status() ? "yes" : "NO — the endpoint confirms which ids are real"
    }`,
  );

  line();
  const passed =
    attempt.status() === 404 &&
    !body.includes(their_title) &&
    ghost.status() === attempt.status();
  console.log(passed ? "RESULT: the guess got nothing." : "RESULT: FAILED — data was reachable.");
  line();

  await browser.close();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
