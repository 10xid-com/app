import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { getJob, listJobs, createJob, type Scope } from "@/lib/db";
import { assertRestrictedRole, closePool } from "@/lib/db/connection";

/**
 * The non-negotiable rule, tested at BOTH layers.
 *
 * Testing only the application layer would prove that our TypeScript remembers
 * to filter. That is worth something, but it is not the claim — the claim is
 * that one client cannot read another's data, including through a query nobody
 * has written yet. So these tests also go underneath the application entirely
 * and ask Postgres directly, as the restricted role the application uses.
 *
 * The classic way this test passes while proving nothing is connecting as the
 * table owner or a superuser: Postgres silently ignores row-level security for
 * both. The first test below asserts that is not happening, and everything
 * after it depends on that.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const appRole = new Client({ connectionString: process.env.DATABASE_APP_URL });

let rotaryId = "";
let northstarId = "";
let rotaryJobId = "";
let northstarJobId = "";
let janeId = "";

beforeAll(async () => {
  await owner.connect();
  await appRole.connect();

  const ids = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'jane@rotary.test')  as jane,
      (select id from jobs where ref = 'ROT-0001')            as rotary_job,
      (select id from jobs where ref = 'NOR-0001')            as northstar_job
  `);
  const row = ids.rows[0];
  rotaryId = row.rotary;
  northstarId = row.northstar;
  janeId = row.jane;
  rotaryJobId = row.rotary_job;
  northstarJobId = row.northstar_job;

  expect(rotaryId, "seed data missing — run npm run db:seed").toBeTruthy();
  expect(northstarJobId).toBeTruthy();
});

afterAll(async () => {
  await owner.end();
  await appRole.end();
  await closePool();
});

const scopeFor = (organizationId: string | null, isStaff = false): Scope => ({
  userId: janeId,
  email: "jane@rotary.test",
  isStaff,
  organizationId,
});

describe("the startup guard", () => {
  test("accepts the restricted role the application actually uses", async () => {
    // Runs against DATABASE_APP_URL, the same connection the app opens.
    await expect(assertRestrictedRole()).resolves.toBeUndefined();
  });

  test("its detection query would catch a privileged connection", async () => {
    // The guard cannot be pointed at another connection without rebuilding the
    // pool, so the query it relies on is checked directly against the OWNER —
    // proving the detection works rather than assuming it does. If this
    // reported a clean bill of health for the owner, the guard would pass for
    // a connection under which row-level security is inactive.
    const { rows } = await owner.query(`
      select r.rolsuper, r.rolbypassrls,
             (select count(*)::int from pg_tables
               where schemaname='public' and tablename in ('jobs','job_events','api_keys','invitations')
                 and tableowner = current_user) as owns
        from pg_roles r where r.rolname = current_user
    `);
    const privileged =
      rows[0].rolsuper || rows[0].rolbypassrls || rows[0].owns > 0;
    expect(privileged).toBe(true);
  });
});

describe("the database itself enforces the rule", () => {
  test("the application's role cannot bypass row-level security", async () => {
    const { rows } = await appRole.query(`
      select current_user as role, r.rolsuper, r.rolbypassrls,
             (select count(*)::int from pg_tables
               where schemaname='public' and tablename in ('jobs','job_events','api_keys','invitations')
                 and tableowner = current_user) as owns
        from pg_roles r where r.rolname = current_user
    `);
    const row = rows[0];

    // If any of these were true, every test below would pass vacuously.
    expect(row.rolsuper, "app role is a SUPERUSER").toBe(false);
    expect(row.rolbypassrls, "app role has BYPASSRLS").toBe(false);
    expect(row.owns, "app role OWNS the tenant tables").toBe(0);
  });

  test("an unscoped connection sees nothing at all", async () => {
    const { rows } = await appRole.query("select count(*)::int as n from jobs");
    // Fails closed: forgetting to scope returns nothing, not everything.
    expect(rows[0].n).toBe(0);
  });

  test("scoped to one client, another client's job is invisible by its exact id", async () => {
    await appRole.query("begin");
    await appRole.query("select set_config('app.org_id', $1, true)", [rotaryId]);

    const mine = await appRole.query("select ref from jobs where id = $1", [
      rotaryJobId,
    ]);
    const theirs = await appRole.query("select ref from jobs where id = $1", [
      northstarJobId,
    ]);

    await appRole.query("commit");

    expect(mine.rows).toHaveLength(1);
    expect(theirs.rows).toHaveLength(0);
  });

  test("a client cannot write a row into another client's company", async () => {
    await appRole.query("begin");
    await appRole.query("select set_config('app.org_id', $1, true)", [rotaryId]);

    await expect(
      appRole.query(
        `insert into jobs (id, organization_id, ref, direction, title, created_by)
         values (gen_random_uuid(), $1, 'HACK-1', 'from_client', 'smuggled', $2)`,
        [northstarId, janeId],
      ),
    ).rejects.toThrow(/row-level security/i);

    await appRole.query("rollback");
  });

  test("the audit log cannot be rewritten or erased", async () => {
    await expect(
      appRole.query("update job_events set action = 'tampered'"),
    ).rejects.toThrow(/permission denied/i);

    await expect(appRole.query("delete from job_events")).rejects.toThrow(
      /permission denied/i,
    );
  });

  test("the tenant setting does not survive its transaction", async () => {
    // The pooling footgun: a session-level SET would stay on the connection and
    // be inherited by whoever borrows it next — possibly another client. This
    // fails OPEN when it goes wrong, so it is worth asserting directly.
    await appRole.query("begin");
    await appRole.query("select set_config('app.org_id', $1, true)", [rotaryId]);
    await appRole.query("commit");

    const { rows } = await appRole.query(
      "select coalesce(nullif(current_setting('app.org_id', true), ''), 'unset') as v",
    );
    expect(rows[0].v).toBe("unset");
  });
});

describe("the shared helper enforces the same rule", () => {
  test("a client sees only their own company's jobs", async () => {
    const jobs = await listJobs(scopeFor(rotaryId));
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.organizationId === rotaryId)).toBe(true);
    expect(jobs.some((j) => j.id === northstarJobId)).toBe(false);
  });

  test("guessing another client's job id returns nothing, not a refusal", async () => {
    const stolen = await getJob(scopeFor(rotaryId), northstarJobId);
    const imaginary = await getJob(
      scopeFor(rotaryId),
      "00000000-0000-4000-8000-000000000000",
    );

    // Identical answers. An endpoint that distinguished them would confirm
    // which ids are real and could be walked to enumerate another client's work.
    expect(stolen).toBeNull();
    expect(imaginary).toBeNull();
  });

  test("staff see every client's jobs", async () => {
    const jobs = await listJobs(scopeFor(null, true));
    const orgs = new Set(jobs.map((j) => j.organizationId));
    expect(orgs.size).toBeGreaterThan(1);
    expect(jobs.some((j) => j.id === northstarJobId)).toBe(true);
    expect(jobs.some((j) => j.id === rotaryJobId)).toBe(true);
  });

  test("staff acting on one client see only that client", async () => {
    // Regression. The cross-client read policy is permissive, and Postgres ORs
    // permissive policies together — so leaving it switched on while a grant is
    // held kept every other client visible and made the grant decorative. The
    // flag now means "surveying", and is off the moment a client is chosen.
    const jobs = await listJobs(scopeFor(rotaryId, true));

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.organizationId === rotaryId)).toBe(true);
    expect(jobs.some((j) => j.id === northstarJobId)).toBe(false);

    // And the same through the single-row path, by exact id.
    expect(await getJob(scopeFor(rotaryId, true), northstarJobId)).toBeNull();
  });

  test("staff surveying every client still cannot write to one", async () => {
    // Read across all, write to none: the staff policy is SELECT-only, and a
    // write needs a grant to one named client.
    await expect(
      createJob(scopeFor(null, true), {
        title: "written with no client chosen",
        direction: "to_client",
      }),
    ).rejects.toThrow(/not scoped to a client/i);
  });
});
