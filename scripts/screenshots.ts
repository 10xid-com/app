import { chromium } from "@playwright/test";
import { Client } from "pg";
import { readFile, mkdir } from "node:fs/promises";

/**
 * Capture every Phase 1 screen by driving the real flow — sign in with a real
 * emailed code, hand off across domains, act as staff, and attempt the URL
 * guess. Written to /tmp/portal-shots.
 *
 *   npm run shots
 */

const CHROMIUM =
  process.env.E2E_CHROMIUM_PATH ??
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PRIMARY = `http://${process.env.E2E_PRIMARY_HOST ?? "login.portal-a.test:3000"}`;
const ROTARY = "http://rotary.portal-b.test:3001";
const OUT = "/tmp/portal-shots";
const SINK = process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";

async function codeFor(email: string) {
  const log = await readFile(SINK, "utf8").catch(() => "");
  return log
    .split("\n")
    .filter((l) => l.includes(`\t${email.toLowerCase()}\t`))
    .map((l) => l.split("\t")[2]?.trim())
    .filter(Boolean)
    .at(-1)!;
}

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* CI supplies the environment */
  }
  await mkdir(OUT, { recursive: true });

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("truncate sign_in_codes, staff_grants, sessions cascade");
  const { rows } = await db.query(
    `select (select id from jobs where ref='ROT-0001') as mine,
            (select id from jobs where ref='NOR-0001') as theirs`,
  );
  await db.end();

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  let n = 0;
  const shot = async (name: string) => {
    n += 1;
    const file = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  ${file}`);
  };

  const signIn = async (email: string, next = "/jobs") => {
    await page.goto(`${PRIMARY}/auth/login?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.waitForURL(/\/auth\/verify/);
    await page.getByLabel("Six-digit code").fill(await codeFor(email));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/"));
  };

  console.log("\ncapturing:");

  // --- signed out -----------------------------------------------------------
  await page.goto(`${PRIMARY}/auth/login`);
  await shot("sign-in");

  await page.getByLabel("Email").fill("jane@rotary.test");
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.waitForURL(/\/auth\/verify/);
  await shot("enter-your-code");

  await page.getByLabel("Six-digit code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("load");
  await shot("wrong-code");

  // --- as a client ----------------------------------------------------------
  await signIn("jane@rotary.test");
  await shot("client-jobs");

  await page.goto(`${PRIMARY}/jobs/${rows[0].mine}`);
  await shot("client-job-detail");

  await page.goto(`${PRIMARY}/jobs/${rows[0].theirs}`);
  await shot("client-guessing-another-clients-job");

  // --- the same person, on a different registrable domain -------------------
  await page.goto(`${ROTARY}/jobs`);
  await page.waitForLoadState("load");
  await shot("same-session-on-a-different-domain");

  // --- as staff -------------------------------------------------------------
  await page.context().clearCookies();
  await signIn("paolo@brandingcentres.test", "/jobs");
  await shot("staff-sees-every-client");

  await page.goto(`${PRIMARY}/staff`);
  await shot("staff-client-picker");

  await page.getByLabel("Reason for opening Rotary").fill("client emailed about a proof");
  await page
    .locator("form", { has: page.getByLabel("Reason for opening Rotary") })
    .getByRole("button", { name: "Open" })
    .click();
  await page.waitForURL(/\/jobs/);
  await shot("staff-acting-on-one-client");

  await browser.close();
  console.log(`\n${n} screenshots in ${OUT}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
