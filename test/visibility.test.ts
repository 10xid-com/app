import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import {
  can,
  canSee,
  connect,
  disconnect,
  grant,
  revoke,
} from "@/lib/db/access";
import { closePool } from "@/lib/db/connection";

/**
 * Who can see whom — tested as the situation it was designed for.
 *
 * The scenario, in full, because the whole model falls out of it:
 *
 *   Tom is one of eighteen graphic designers at one company. John heads
 *   marketing at the same company and needs two things made.
 *
 *   The booth goes to JANE, who micromanages — everything routes through her,
 *   so John and Tom never deal with each other directly.
 *
 *   The banner goes to SAM, who works the opposite way — she picks the right
 *   designer, introduces them, and steps back. So John and Tom DO deal with
 *   each other, for that job.
 *
 * Same company, same two people, opposite answers. That is the proof that
 * visibility cannot be derived from employment or from sharing a job: it is a
 * decision somebody makes, and therefore something the database has to record.
 *
 * Separately, John and Tom are neighbours in real life and scanned each other's
 * iD long before any of this. That connection belongs to neither the company
 * nor the job, and must survive both.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

let org = "";
let otherOrg = "";
let john = "";
let jane = "";
let sam = "";
let tom = "";

async function makeUser(email: string) {
  const { rows } = await owner.query(
    `insert into users (email, full_name) values ($1, $2) returning id`,
    [email, email.split("@")[0]],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  await owner.connect();

  const mk = async (name: string, slug: string) =>
    (
      await owner.query(
        `insert into organizations (type, name, slug, member_visibility)
         values ('client', $1, $2, 'closed') returning id`,
        [name, slug],
      )
    ).rows[0].id as string;

  org = await mk("Vis Test Co", `vis-${Date.now()}`);
  otherOrg = await mk("Vis Other Co", `vis-other-${Date.now()}`);

  john = await makeUser(`john-vis-${Date.now()}@test.invalid`);
  jane = await makeUser(`jane-vis-${Date.now()}@test.invalid`);
  sam = await makeUser(`sam-vis-${Date.now()}@test.invalid`);
  tom = await makeUser(`tom-vis-${Date.now()}@test.invalid`);

  for (const u of [john, jane, sam, tom]) {
    await owner.query(
      `insert into memberships (user_id, organization_id, role) values ($1,$2,'member')`,
      [u, org],
    );
  }
});

afterAll(async () => {
  const users = [john, jane, sam, tom].filter(Boolean);
  const orgs = [org, otherOrg].filter(Boolean);
  await owner.query(`delete from permissions where organization_id = any($1::uuid[])`, [orgs]);
  await owner.query(`delete from connections where a_user_id = any($1::uuid[]) or b_user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from memberships where user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from user_emails where user_id = any($1::uuid[])`, [users]);
  await owner.query(`delete from users where id = any($1::uuid[])`, [users]);
  await owner.query(`delete from organizations where id = any($1::uuid[])`, [orgs]);
  await owner.end();
  await closePool();
});

describe("nobody is visible by default", () => {
  test("sharing an employer shows you nothing", async () => {
    expect(await canSee(org, john, tom)).toBe(false);
    expect(await canSee(org, john, jane)).toBe(false);
    expect(await canSee(org, sam, tom)).toBe(false);
  });

  test("you can always see yourself", async () => {
    expect(await canSee(org, tom, tom)).toBe(true);
  });
});

describe("Jane brokers, Sam introduces", () => {
  test("John deals with Jane, so John and Jane connect", async () => {
    await connect({
      organizationId: org,
      userId: john,
      otherUserId: jane,
      source: "shared_work",
      createdBy: john,
    });
    expect(await canSee(org, john, jane)).toBe(true);
  });

  test("Jane assigns Tom, so Jane and Tom connect — but John still cannot see Tom", async () => {
    await connect({
      organizationId: org,
      userId: jane,
      otherUserId: tom,
      source: "shared_work",
      createdBy: jane,
    });
    expect(await canSee(org, jane, tom)).toBe(true);

    // The whole point of Jane's way of working. Two hops is not a connection:
    // John -> Jane -> Tom leaves John and Tom strangers, which is exactly what
    // an agency hiding its contractors from its client depends on.
    expect(await canSee(org, john, tom)).toBe(false);
  });

  test("Sam introduces John to Tom, and now they can see each other", async () => {
    await connect({
      organizationId: org,
      userId: john,
      otherUserId: tom,
      source: "shared_work",
      createdBy: sam,
    });
    expect(await canSee(org, john, tom)).toBe(true);
    // Mutual, necessarily. There is no direction in which one sees the other
    // and the other does not.
    expect(await canSee(org, tom, john)).toBe(true);
  });

  test("introducing the same pair twice is not an error", async () => {
    const again = await connect({
      organizationId: org,
      userId: tom,
      otherUserId: john,
      source: "shared_work",
      createdBy: sam,
    });
    expect(again).not.toBeNull();
    const { rows } = await owner.query(
      `select count(*)::int as n from connections
        where organization_id = $1 and revoked_at is null
          and a_user_id = least($2::uuid,$3::uuid)
          and b_user_id = greatest($2::uuid,$3::uuid)`,
      [org, john, tom],
    );
    expect(rows[0].n).toBe(1);
  });

  test("the database refuses a reversed duplicate, not just the helper", async () => {
    await expect(
      owner.query(
        `insert into connections (organization_id, a_user_id, b_user_id, source)
         values ($1, greatest($2::uuid,$3::uuid), least($2::uuid,$3::uuid), 'manual')`,
        [org, john, tom],
      ),
    ).rejects.toThrow(/connections_pair_ordered/);
  });

  test("a connection is revoked, not deleted, and seeing stops", async () => {
    expect(await disconnect({ organizationId: org, userId: john, otherUserId: tom })).toBe(true);
    expect(await canSee(org, john, tom)).toBe(false);

    const { rows } = await owner.query(
      `select count(*)::int as n from connections
        where organization_id = $1 and revoked_at is not null
          and a_user_id = least($2::uuid,$3::uuid)
          and b_user_id = greatest($2::uuid,$3::uuid)`,
      [org, john, tom],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("a personal connection is not the company's to control", () => {
  test("John and Tom are neighbours — they scanned each other's iD", async () => {
    await connect({
      organizationId: null,
      userId: john,
      otherUserId: tom,
      source: "id_scan",
      createdBy: john,
    });
    // Visible in this company...
    expect(await canSee(org, john, tom)).toBe(true);
    // ...and in one neither of them works for, because it was never about work.
    expect(await canSee(otherOrg, john, tom)).toBe(true);
  });

  test("the company revoking its own connection does not touch the personal one", async () => {
    await disconnect({ organizationId: org, userId: john, otherUserId: tom });
    expect(await canSee(org, john, tom)).toBe(true);
  });
});

describe("an open organization shows everyone to everyone", () => {
  test("flipping to open takes effect immediately, with no rows written", async () => {
    const before = await owner.query(`select count(*)::int as n from connections where organization_id = $1`, [org]);
    await owner.query(`update organizations set member_visibility = 'open' where id = $1`, [org]);

    expect(await canSee(org, sam, tom)).toBe(true);

    const after = await owner.query(`select count(*)::int as n from connections where organization_id = $1`, [org]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("and flipping back closes it again just as fast", async () => {
    await owner.query(`update organizations set member_visibility = 'closed' where id = $1`, [org]);
    expect(await canSee(org, sam, tom)).toBe(false);
  });

  test("open does not leak across organizations", async () => {
    await owner.query(`update organizations set member_visibility = 'open' where id = $1`, [otherOrg]);
    // Sam and Tom belong to `org`, not `otherOrg`. An open company they are
    // not in must not make them visible to each other.
    expect(await canSee(otherOrg, sam, tom)).toBe(false);
    await owner.query(`update organizations set member_visibility = 'closed' where id = $1`, [otherOrg]);
  });
});

describe("capabilities are data, and a deny beats a grant", () => {
  test("nothing is permitted until it is granted", async () => {
    expect(await can(org, sam, "task.assign")).toBe(false);
  });

  test("a capability nobody wrote code for still works", async () => {
    // The requirement: inventing a verb must not need a migration or a deploy.
    await grant({
      organizationId: org,
      userId: sam,
      capability: "task.assign.without.asking.jane",
      grantedBy: john,
    });
    expect(await can(org, sam, "task.assign.without.asking.jane")).toBe(true);
  });

  test("an organization-wide grant covers a specific thing inside it", async () => {
    await grant({
      organizationId: org,
      userId: sam,
      capability: "task.approve",
      grantedBy: john,
    });
    expect(await can(org, sam, "task.approve", { type: "task", id: tom })).toBe(true);
  });

  test("a grant scoped to one thing does not cover another", async () => {
    await grant({
      organizationId: org,
      userId: tom,
      capability: "task.edit",
      scope: { type: "task", id: john },
      grantedBy: jane,
    });
    expect(await can(org, tom, "task.edit", { type: "task", id: john })).toBe(true);
    expect(await can(org, tom, "task.edit", { type: "task", id: sam })).toBe(false);
  });

  test("a deny carves one person out of what they were granted", async () => {
    await grant({
      organizationId: org,
      userId: jane,
      capability: "person.see",
      grantedBy: john,
    });
    expect(await can(org, jane, "person.see")).toBe(true);

    await grant({
      organizationId: org,
      userId: jane,
      capability: "person.see",
      scope: { type: "user", id: sam },
      deny: true,
      grantedBy: john,
    });
    // Still allowed in general...
    expect(await can(org, jane, "person.see")).toBe(true);
    // ...but not about Sam.
    expect(await can(org, jane, "person.see", { type: "user", id: sam })).toBe(false);
  });

  test("revoking is a timestamp, and the capability stops", async () => {
    expect(await revoke({ organizationId: org, userId: sam, capability: "task.approve" })).toBe(1);
    expect(await can(org, sam, "task.approve")).toBe(false);

    const { rows } = await owner.query(
      `select count(*)::int as n from permissions
        where organization_id = $1 and user_id = $2
          and capability = 'task.approve' and revoked_at is not null`,
      [org, sam],
    );
    expect(rows[0].n).toBe(1);
  });

  test("permissions do not cross organizations", async () => {
    await grant({
      organizationId: org,
      userId: sam,
      capability: "task.create",
      grantedBy: john,
    });
    expect(await can(org, sam, "task.create")).toBe(true);
    expect(await can(otherOrg, sam, "task.create")).toBe(false);
  });
});
