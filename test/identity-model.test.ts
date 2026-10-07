import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import {
  addEmailToAccount,
  emailsForUser,
  findUserByEmail,
  identityByCode,
  identityForUser,
  issueIdentity,
  revokeIdentity,
  setPrimaryEmail,
  verifyEmail,
} from "@/lib/db/identity";
import { closePool } from "@/lib/db/connection";

/**
 * The account / iD model, tested against the database rather than against the
 * helpers that are supposed to uphold it.
 *
 * Two claims are load-bearing, and both are cheap now and ruinous to retrofit:
 *
 *   1. An address is a CLAIM on an account, not the account. Several per
 *      account, one primary, each verified on its own, and globally unique so
 *      two accounts cannot both hold one.
 *
 *   2. An iD is issued ON TOP OF an account and nothing references it. One live
 *      iD at a time; a code is never reissued to anybody, ever; and revoking
 *      one leaves every membership and every job exactly where it was.
 *
 * Where a rule is meant to be enforced by the DATABASE, the test provokes it
 * through a raw connection as well — a constraint that exists only in
 * TypeScript is one `db.insert` away from not existing at all.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

let alice = "";
let bob = "";

beforeAll(async () => {
  await owner.connect();
  const { rows } = await owner.query(`
    insert into users (email, full_name)
    values ('alice-model@test.invalid', 'Alice'),
           ('bob-model@test.invalid',   'Bob')
    returning id, email
  `);
  alice = rows.find((r) => r.email.startsWith("alice"))!.id;
  bob = rows.find((r) => r.email.startsWith("bob"))!.id;

  // No primary address is inserted here: migration 0010 puts a trigger on
  // users INSERT that writes it. That is deliberate in the fixture too — if the
  // trigger ever stops firing, these tests fail rather than papering over it
  // with a row the real sign-up path would not have created.
  await owner.query(
    `update user_emails set verified_at = now() where user_id = any($1::uuid[])`,
    [[alice, bob]],
  );
});

afterAll(async () => {
  await owner.query(
    `delete from identities where user_id = any($1::uuid[])`, [[alice, bob]],
  );
  await owner.query(
    `delete from user_emails where user_id = any($1::uuid[])`, [[alice, bob]],
  );
  await owner.query(`delete from users where id = any($1::uuid[])`, [[alice, bob]]);
  await owner.end();
  await closePool();
});

describe("an address is a claim on an account, not the account", () => {
  test("the backfill gave every pre-existing account its address as primary", async () => {
    const { rows } = await owner.query(`
      select count(*)::int as n
        from users u
       where u.deleted_at is null
         and not exists (
           select 1 from user_emails e
            where e.user_id = u.id and e.is_primary
         )
    `);
    expect(rows[0].n).toBe(0);
  });

  test("an account created today gets its primary address automatically", async () => {
    // The gap migration 0010 closes. Sign-in resolves through user_emails, so
    // an account created without a row there cannot sign in — and it fails
    // looking like a wrong code rather than a missing row. Twelve accounts were
    // in exactly that state before the trigger existed.
    const { rows } = await owner.query(
      `insert into users (email, full_name)
       values ('fresh-model@test.invalid', 'Fresh') returning id`,
    );
    const fresh = rows[0].id;
    try {
      const primaries = (await emailsForUser(fresh)).filter((e) => e.isPrimary);
      expect(primaries).toHaveLength(1);
      expect(primaries[0].email).toBe("fresh-model@test.invalid");
      expect((await findUserByEmail("fresh-model@test.invalid"))?.id).toBe(fresh);
    } finally {
      await owner.query(`delete from user_emails where user_id = $1`, [fresh]);
      await owner.query(`delete from users where id = $1`, [fresh]);
    }
  });

  test("a sign-up onto somebody else's claimed address is refused, not broken", async () => {
    // The one case the trigger must NOT swallow. users.email's own unique
    // constraint does not see secondary addresses, so without the trigger
    // raising, this would create an account that exists and can never sign in.
    await addEmailToAccount(bob, "contested@test.invalid");
    await expect(
      owner.query(
        `insert into users (email, full_name)
         values ('contested@test.invalid', 'Contested')`,
      ),
    ).rejects.toThrow(/user_emails_email_unique|duplicate key/);
  });

  test("an account can hold several addresses", async () => {
    await addEmailToAccount(alice, "Alice.Work@Test.Invalid");
    const list = await emailsForUser(alice);
    expect(list.map((e) => e.email)).toContain("alice.work@test.invalid");
    expect(list).toHaveLength(2);
  });

  test("a second address is stored unverified, and cannot sign in yet", async () => {
    const found = await findUserByEmail("alice.work@test.invalid");
    expect(found).toBeNull();
  });

  test("once verified, the same address reaches the same account", async () => {
    expect(await verifyEmail(alice, "alice.work@test.invalid")).toBe(true);
    const found = await findUserByEmail("alice.work@test.invalid");
    expect(found?.id).toBe(alice);
  });

  test("the original address still reaches that account too", async () => {
    const found = await findUserByEmail("alice-model@test.invalid");
    expect(found?.id).toBe(alice);
  });

  test("two accounts cannot hold the same address", async () => {
    const stolen = await addEmailToAccount(bob, "alice.work@test.invalid");
    expect(stolen).toBeNull();
    // and it still belongs to Alice
    expect((await findUserByEmail("alice.work@test.invalid"))?.id).toBe(alice);
  });

  test("the database refuses a second primary, not merely the helper", async () => {
    await expect(
      owner.query(
        `insert into user_emails (user_id, email, is_primary)
         values ($1, 'alice-second-primary@test.invalid', true)`,
        [alice],
      ),
    ).rejects.toThrow(/user_emails_one_primary_per_user/);
  });

  test("promoting an address moves the primary and the users.email mirror", async () => {
    expect(await setPrimaryEmail(alice, "alice.work@test.invalid")).toBe(true);
    const { rows } = await owner.query(
      `select email from users where id = $1`, [alice],
    );
    expect(rows[0].email).toBe("alice.work@test.invalid");

    const primaries = (await emailsForUser(alice)).filter((e) => e.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].email).toBe("alice.work@test.invalid");
  });

  test("an unverified address cannot be promoted to primary", async () => {
    await addEmailToAccount(alice, "alice-unconfirmed@test.invalid");
    expect(await setPrimaryEmail(alice, "alice-unconfirmed@test.invalid")).toBe(false);
    const { rows } = await owner.query(
      `select email from users where id = $1`, [alice],
    );
    expect(rows[0].email).toBe("alice.work@test.invalid");
  });
});

describe("an iD sits on top of an account and owns nothing", () => {
  test("an account starts with no iD", async () => {
    expect(await identityForUser(bob)).toBeNull();
  });

  test("an iD can be issued", async () => {
    const issued = await issueIdentity(bob, "10X-TEST-0001");
    expect(issued?.idCode).toBe("10X-TEST-0001");
    expect((await identityForUser(bob))?.idCode).toBe("10X-TEST-0001");
  });

  test("an account cannot hold two live iDs", async () => {
    expect(await issueIdentity(bob, "10X-TEST-0002")).toBeNull();
  });

  test("the database refuses the second live iD, not merely the helper", async () => {
    await expect(
      owner.query(
        `insert into identities (user_id, id_code) values ($1, '10X-TEST-0003')`,
        [bob],
      ),
    ).rejects.toThrow(/identities_one_live_per_user/);
  });

  test("two accounts cannot hold the same code", async () => {
    expect(await issueIdentity(alice, "10X-TEST-0001")).toBeNull();
  });

  test("revoking leaves the row, so the code stays spent", async () => {
    expect(await revokeIdentity(bob)).toBe(true);
    expect(await identityForUser(bob)).toBeNull();

    const row = await identityByCode("10X-TEST-0001");
    expect(row).not.toBeNull();
    expect(row!.revokedAt).not.toBeNull();
  });

  test("a revoked code can NEVER be reissued, to anyone", async () => {
    expect(await issueIdentity(bob, "10X-TEST-0001")).toBeNull();
    expect(await issueIdentity(alice, "10X-TEST-0001")).toBeNull();
  });

  test("but the account can be issued a different iD afterwards", async () => {
    const again = await issueIdentity(bob, "10X-TEST-0004");
    expect(again?.idCode).toBe("10X-TEST-0004");
  });

  test("the application role cannot DELETE an iD", async () => {
    const { rows } = await owner.query(`
      select count(*)::int as n
        from information_schema.role_table_grants
       where grantee = 'portal_app'
         and table_name = 'identities'
         and privilege_type = 'DELETE'
    `);
    expect(rows[0].n).toBe(0);
  });

  test("nothing in the schema references the iD code", async () => {
    // The rule the whole model rests on: transferring or revoking an iD must
    // not be able to reach anybody's history. If a foreign key ever points at
    // identities.id_code, that guarantee is gone and this fails.
    const { rows } = await owner.query(`
      select tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY'
         and ccu.table_name = 'identities'
    `);
    expect(rows).toEqual([]);
  });
});
