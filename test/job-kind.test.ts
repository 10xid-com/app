import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { createJob, getJob, listJobEvents, listJobs, setJobKind, type Scope } from "@/lib/db";
import { mintKey } from "@/lib/db/api-keys";
import { closePool } from "@/lib/db/connection";
import { POST } from "@/app/api/v1/jobs/route";

/**
 * A job is a quote, an estimate or a job (login's 0033). Website forms file
 * quotes and estimates through the intake endpoint; the business moves them
 * along, and every change is in the job's history.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

let rotaryId = "";
let northstarId = "";
let janeId = "";
let paoloId = "";

const jane = (): Scope => ({ userId: janeId, email: "jane@rotary.test", isStaff: false, organizationId: rotaryId });

beforeAll(async () => {
  await owner.connect();
  const { rows } = await owner.query(`
    select (select id from organizations where slug = 'rotary')    as rotary,
           (select id from organizations where slug = 'northstar') as northstar,
           (select id from users where email = 'jane@rotary.test')  as jane,
           (select id from users where email = 'paolo@brandingcentres.test') as paolo
  `);
  ({ rotary: rotaryId, northstar: northstarId, jane: janeId, paolo: paoloId } = rows[0]);
  expect(rotaryId, "seed data missing — run login's db:seed").toBeTruthy();
});

afterAll(async () => {
  await owner.end();
  await closePool();
});

const post = (key: string, body: unknown) =>
  POST(
    new Request("https://app.10xid.test/api/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("from a website's form", () => {
  test("a quote and an estimate land as what they are, and saying nothing is a job", async () => {
    const { secret } = await mintKey({ organizationId: northstarId, label: "Kind test", createdBy: paoloId });

    const quote = await post(secret, { title: "Quote request – A Person", kind: "quote", details: { Name: "A Person" } });
    expect(quote.status).toBe(201);
    expect(await quote.json()).toMatchObject({ kind: "quote" });

    const estimate = await post(secret, { title: "Estimate request – A Person", kind: "estimate" });
    expect(await estimate.json()).toMatchObject({ kind: "estimate" });

    const plain = await post(secret, { title: "Something with no kind" });
    expect(await plain.json()).toMatchObject({ kind: "job" });
  });

  test("anything else is refused, and nothing is filed", async () => {
    const { secret } = await mintKey({ organizationId: northstarId, label: "Kind test 2", createdBy: paoloId });
    const before = await owner.query("select count(*)::int as n from jobs where organization_id = $1", [northstarId]);
    const res = await post(secret, { title: "An order", kind: "order" });
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0].path).toBe("kind");
    const after = await owner.query("select count(*)::int as n from jobs where organization_id = $1", [northstarId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("in the portal", () => {
  test("a job is made as the kind chosen, and the list filters by kind", async () => {
    const job = await createJob(jane(), { title: "Kind test: banner estimate", direction: "from_client", kind: "estimate" });
    expect(job.kind).toBe("estimate");

    const estimates = await listJobs(jane(), { kind: "estimate" });
    expect(estimates.map((j) => j.id)).toContain(job.id);
    expect(estimates.every((j) => j.kind === "estimate")).toBe(true);
    expect((await listJobs(jane(), { kind: "quote" })).map((j) => j.id)).not.toContain(job.id);
  });

  test("a quote the customer accepts becomes a job, and the history says so", async () => {
    const job = await createJob(jane(), { title: "Kind test: van wrap quote", direction: "from_client", kind: "quote" });

    const changed = await setJobKind(jane(), job.id, "job", "quote");
    expect(changed?.kind).toBe("job");
    const events = await listJobEvents(jane(), job.id);
    expect(events[0]).toMatchObject({ action: "kind_changed", before: { kind: "quote" }, after: { kind: "job" } });
  });

  test("a change made against a kind that has since moved on is not applied", async () => {
    const job = await createJob(jane(), { title: "Kind test: stale change", direction: "from_client", kind: "quote" });
    await setJobKind(jane(), job.id, "estimate", "quote");
    expect(await setJobKind(jane(), job.id, "job", "quote")).toBeNull();
    expect((await getJob(jane(), job.id))?.kind).toBe("estimate");
  });

  test("another business's job cannot be changed", async () => {
    const { rows } = await owner.query("select id from jobs where ref = 'NOR-0001'");
    expect(await setJobKind(jane(), rows[0].id, "quote", "job")).toBeNull();
    const after = await owner.query("select kind from jobs where id = $1", [rows[0].id]);
    expect(after.rows[0].kind).toBe("job");
  });
});
