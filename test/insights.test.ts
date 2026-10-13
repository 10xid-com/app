import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { createJob, monthlyIntake, setJobKind, setJobStatus, submissions, workOutcomes, type Scope } from "@/lib/db";
import { closePool } from "@/lib/db/connection";

/**
 * The figures behind Customers and Analytics, on a business of their own so
 * the counts are exact, and never another business's rows.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `ins${Date.now().toString(36)}`;
let orgId = "";
let otherId = "";
let janeId = "";

const scope = (organizationId = orgId): Scope => ({ userId: janeId, email: "jane@rotary.test", isStaff: false, organizationId });

beforeAll(async () => {
  await owner.connect();
  janeId = (await owner.query("select id from users where email = 'jane@rotary.test'")).rows[0]?.id;
  expect(janeId, "seed data missing — run login's db:seed").toBeTruthy();
  const made = await owner.query(
    "insert into organizations (type, name, slug) values ('client', $1, $1), ('client', $2, $2) returning id",
    [`${TAG}-a`, `${TAG}-b`],
  );
  [orgId, otherId] = made.rows.map((r) => r.id);
});

afterAll(async () => {
  await owner.end();
  await closePool();
});

describe("what was sent in", () => {
  test("each submission with the details typed into it; work sent out is not a submission", async () => {
    await createJob(scope(), { title: "Decals", direction: "from_client", kind: "quote", details: { email: "jo@example.com" } });
    await createJob(scope(), { title: "Our own job", direction: "to_client", kind: "job" });
    await createJob(scope(otherId), { title: "Not ours", direction: "from_client", kind: "quote", details: { email: "x@y.co" } });

    const rows = await submissions(scope());
    expect(rows.map((r) => [r.title, r.details])).toEqual([["Decals", { email: "jo@example.com" }]]);
  });
});

describe("the analytics figures", () => {
  test("this month's intake, quotes apart from jobs, with the empty months in the window", async () => {
    const months = await monthlyIntake(scope(), 6);
    expect(months).toHaveLength(6);
    expect(months.slice(0, 5).every((m) => m.quotes === 0 && m.jobs === 0)).toBe(true);
    expect(months[5]).toEqual({ month: new Date().toISOString().slice(0, 7), quotes: 1, jobs: 1 });
  });

  test("quotes won, and how long completed work took", async () => {
    const quote = await createJob(scope(), { title: "Wrap estimate", direction: "from_client", kind: "estimate" });
    await setJobKind(scope(), quote.id, "job", "estimate");
    await setJobStatus(scope(), quote.id, "completed", "open");

    const outcomes = await workOutcomes(scope());
    expect(outcomes).toMatchObject({ quoted: 2, won: 1, completed: 1 });
    expect(outcomes.medianDaysToComplete).toBeGreaterThanOrEqual(0);
    expect(outcomes.medianDaysToComplete).toBeLessThan(1);

    // Another business's figures are its own.
    expect(await workOutcomes(scope(otherId))).toMatchObject({ quoted: 1, won: 0, completed: 0, medianDaysToComplete: null });
  });
});
