import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { isStaffMembership, sessionRoleFor } from "@/lib/auth/policy";
import { startSession } from "@/lib/auth/session";
import { acceptInvitation, inviteToOrganization } from "@/lib/db/invitations";
import { internalOrganization } from "@/lib/db/identity";
import { closePool } from "@/lib/db/connection";

/**
 * WHAT MAKES A SESSION STAFF — the rules, pinned.
 *
 * The derivation used to be `mships.some((m) => m.organizationType ===
 * "internal")`, so being ADDED to the house was authority over every client's
 * data whatever the membership said, and the `staff` value in the
 * membership_role enum decided nothing. 0013 found the live proof: an
 * administrator who does the books, holding a staff session.
 *
 * These are the four cases, and they are written down here because they are
 * the whole of the rule and because the wrong answer to any of them is one
 * client reading another's work:
 *
 *   internal + staff   -> staff
 *   internal + member  -> NOT staff   (the case that used to be wrong)
 *   client   + staff   -> NOT staff   (a client company cannot mint authority)
 *   no membership      -> NOT staff
 *
 * Each is asserted three times over, because the rule is written down in three
 * places that must never diverge:
 *
 *   1. sessionRoleFor() — the pure function, with no database at all.
 *   2. startSession()   — the real sign-in path, against real rows, reading
 *                         the role it stamps on the session.
 *   3. users.is_staff   — the stored copy, through acceptInvitation() and
 *                         through the database triggers that keep it in step.
 *
 * A rule that is true in the pure function and false in the path people
 * actually take is not a rule, so the pure tests alone would not be enough.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

const stamp = Date.now();
let internalOrg = "";
let secondInternalOrg = "";
let clientOrg = "";
let inHouseAsStaff = "";
let inHouseAsMember = "";
let atClientAsStaff = "";
let unattached = "";
const created: string[] = [];

async function mkOrg(type: string, slug: string) {
  const { rows } = await owner.query(
    `insert into organizations (type, name, slug) values ($1,$2,$3) returning id`,
    [type, slug, slug],
  );
  return rows[0].id as string;
}

async function mkUser(label: string, isStaff = false) {
  const email = `${label}-${stamp}@test.invalid`;
  const { rows } = await owner.query(
    `insert into users (email, full_name, is_staff) values ($1,$2,$3) returning id`,
    [email, label, isStaff],
  );
  created.push(rows[0].id);
  return rows[0].id as string;
}

async function join(userId: string, orgId: string, role: string) {
  await owner.query(
    `insert into memberships (user_id, organization_id, role) values ($1,$2,$3)`,
    [userId, orgId, role],
  );
}

async function isStaffOf(userId: string): Promise<boolean> {
  const { rows } = await owner.query(
    `select is_staff from users where id = $1`,
    [userId],
  );
  return rows[0].is_staff as boolean;
}

beforeAll(async () => {
  await owner.connect();

  internalOrg = await mkOrg("internal", `deriv-house-${stamp}`);
  secondInternalOrg = await mkOrg("internal", `deriv-house2-${stamp}`);
  clientOrg = await mkOrg("client", `deriv-client-${stamp}`);

  inHouseAsStaff = await mkUser("deriv-staff");
  inHouseAsMember = await mkUser("deriv-bookkeeper");
  atClientAsStaff = await mkUser("deriv-clientstaff");
  unattached = await mkUser("deriv-nobody");

  await join(inHouseAsStaff, internalOrg, "staff");
  await join(inHouseAsMember, internalOrg, "member");
  // A `staff` role inside a CLIENT company. Nonsense, and allowed by the enum,
  // which is exactly why it has to be tested rather than assumed impossible.
  await join(atClientAsStaff, clientOrg, "staff");
});

afterAll(async () => {
  const orgs = [internalOrg, secondInternalOrg, clientOrg].filter(Boolean);
  await owner.query(`delete from sessions where user_id = any($1::uuid[])`, [created]);
  await owner.query(`delete from invitations where organization_id = any($1::uuid[])`, [orgs]);
  await owner.query(`delete from memberships where organization_id = any($1::uuid[])`, [orgs]);
  await owner.query(`delete from user_emails where user_id = any($1::uuid[])`, [created]);
  await owner.query(`delete from users where id = any($1::uuid[])`, [created]);
  await owner.query(`delete from organizations where id = any($1::uuid[])`, [orgs]);
  await owner.end();
  await closePool();
});

/* ------------------------------------------------------------------ */

describe("the rule itself", () => {
  test("internal + staff is staff", () => {
    expect(
      sessionRoleFor([{ organizationType: "internal", role: "staff" }]),
    ).toBe("staff");
    expect(isStaffMembership({ organizationType: "internal", role: "staff" })).toBe(true);
  });

  test("internal + member is NOT staff", () => {
    expect(
      sessionRoleFor([{ organizationType: "internal", role: "member" }]),
    ).toBe("client");
  });

  test("internal + owner is NOT staff either", () => {
    // Owning the house is not the same as working for its clients, and the
    // enum offers three values, so the middle one cannot be left to inference.
    expect(
      sessionRoleFor([{ organizationType: "internal", role: "owner" }]),
    ).toBe("client");
  });

  test("client + staff is NOT staff", () => {
    expect(
      sessionRoleFor([{ organizationType: "client", role: "staff" }]),
    ).toBe("client");
    expect(isStaffMembership({ organizationType: "client", role: "staff" })).toBe(false);
  });

  test("no membership at all is NOT staff", () => {
    expect(sessionRoleFor([])).toBe("client");
  });

  test("one qualifying membership among several is enough", () => {
    // Staff belong to client companies too — Paolo owns a brand. The rule is
    // "holds at least one", not "holds only".
    expect(
      sessionRoleFor([
        { organizationType: "client", role: "owner" },
        { organizationType: "client", role: "member" },
        { organizationType: "internal", role: "staff" },
      ]),
    ).toBe("staff");
  });

  test("a pile of near misses is still not staff", () => {
    expect(
      sessionRoleFor([
        { organizationType: "internal", role: "member" },
        { organizationType: "internal", role: "owner" },
        { organizationType: "client", role: "staff" },
        { organizationType: "client", role: "owner" },
      ]),
    ).toBe("client");
  });
});

/* ------------------------------------------------------------------ */

describe("the sign-in path agrees, against real rows", () => {
  const signIn = (userId: string) =>
    startSession({ userId, host: "login.portal-a.test", secondFactorPassed: true });

  test("a staff-role member of the house gets a staff session", async () => {
    expect((await signIn(inHouseAsStaff)).role).toBe("staff");
  });

  test("an ordinary member of the house does NOT", async () => {
    // Peter, in production: an administrator who does the books, who held a
    // staff session over every client until this changed.
    expect((await signIn(inHouseAsMember)).role).toBe("client");
  });

  test("a `staff` role inside a CLIENT company does NOT", async () => {
    expect((await signIn(atClientAsStaff)).role).toBe("client");
  });

  test("somebody with no membership at all does NOT", async () => {
    expect((await signIn(unattached)).role).toBe("client");
  });

  test("the role is stamped on the session row, not recomputed per request", async () => {
    const { sessionId } = await signIn(inHouseAsStaff);
    const { rows } = await owner.query(
      `select role_at_creation from sessions where id = $1`,
      [sessionId],
    );
    expect(rows[0].role_at_creation).toBe("staff");
  });
});

/* ------------------------------------------------------------------ */

describe("users.is_staff follows the same rule", () => {
  /**
   * The stored flag is a denormalised copy of what the session derives. It was
   * written from the company alone (`org?.type === "internal"`), which is the
   * same defect at the other end: invite a bookkeeper into the house and they
   * arrived flagged staff.
   */
  const invite = async (orgId: string, role: "owner" | "member" | "staff") => {
    const email = `deriv-invited-${role}-${orgId.slice(0, 8)}-${stamp}@test.invalid`;
    const { id } = await inviteToOrganization({
      organizationId: orgId,
      email,
      role,
      invitedBy: inHouseAsStaff,
    });
    const accepted = await acceptInvitation({
      invitationId: id,
      organizationId: orgId,
      email,
      role,
    });
    created.push(accepted!.userId);
    return accepted!.userId;
  };

  test("invited into the house AS STAFF -> is_staff true", async () => {
    expect(await isStaffOf(await invite(internalOrg, "staff"))).toBe(true);
  });

  test("invited into the house as a member -> is_staff false", async () => {
    expect(await isStaffOf(await invite(internalOrg, "member"))).toBe(false);
  });

  test("invited into a CLIENT company as `staff` -> is_staff false", async () => {
    expect(await isStaffOf(await invite(clientOrg, "staff"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("the flag cannot drift away from the memberships", () => {
  /**
   * 0017 puts the rule in the database as well, because nothing recomputed the
   * flag after an account was created — it was written once at sign-up and
   * never revisited, which is how Peter's came to be wrong. These are the two
   * things that can change the answer.
   */
  test("gaining and losing a staff-role membership moves the flag", async () => {
    const person = await mkUser("deriv-promoted");
    expect(await isStaffOf(person)).toBe(false);

    await join(person, internalOrg, "member");
    expect(await isStaffOf(person)).toBe(false);

    await owner.query(
      `update memberships set role = 'staff' where user_id = $1 and organization_id = $2`,
      [person, internalOrg],
    );
    expect(await isStaffOf(person)).toBe(true);

    await owner.query(
      `update memberships set role = 'member' where user_id = $1 and organization_id = $2`,
      [person, internalOrg],
    );
    expect(await isStaffOf(person)).toBe(false);

    await owner.query(
      `update memberships set role = 'staff' where user_id = $1 and organization_id = $2`,
      [person, internalOrg],
    );
    expect(await isStaffOf(person)).toBe(true);

    await owner.query(
      `delete from memberships where user_id = $1 and organization_id = $2`,
      [person, internalOrg],
    );
    expect(await isStaffOf(person)).toBe(false);
  });

  test("retyping the company moves it too, without a membership changing", async () => {
    // This is 0016 in miniature: branding-centres went internal -> client and
    // nobody's membership row moved.
    const house = await mkOrg("internal", `deriv-retype-${stamp}`);
    const person = await mkUser("deriv-retyped");
    await join(person, house, "staff");
    expect(await isStaffOf(person)).toBe(true);

    await owner.query(`update organizations set type = 'client' where id = $1`, [house]);
    expect(await isStaffOf(person)).toBe(false);

    await owner.query(`update organizations set type = 'internal' where id = $1`, [house]);
    expect(await isStaffOf(person)).toBe(true);

    // Soft-deleting the house has the same effect, because membershipsForUser()
    // filters deleted companies out and the flag must not count what the
    // session cannot see.
    await owner.query(`update organizations set deleted_at = now() where id = $1`, [house]);
    expect(await isStaffOf(person)).toBe(false);

    await owner.query(`delete from memberships where organization_id = $1`, [house]);
    await owner.query(`delete from organizations where id = $1`, [house]);
  });
});

/* ------------------------------------------------------------------ */

describe("internalOrganization() refuses to guess", () => {
  /**
   * It used to take the first row it found. With two candidates that means
   * POSTGRES decides which company is the house, by whatever order a scan
   * happens to return — and production really did hold two.
   */
  test("with more than one, it throws and names them", async () => {
    await expect(internalOrganization()).rejects.toThrow(/type 'internal'/);
    await expect(internalOrganization()).rejects.toThrow(
      new RegExp(`deriv-house-${stamp}`),
    );
  });

  test("with exactly one it returns it, and with none it returns null", async () => {
    // Every other live internal company is hidden for the duration, including
    // whatever the seed or the migrations left behind, so this does not depend
    // on what else is in the database.
    const { rows: others } = await owner.query(
      `select id from organizations where type = 'internal' and deleted_at is null and id <> $1`,
      [internalOrg],
    );
    const hidden = others.map((r) => r.id);
    try {
      await owner.query(
        `update organizations set deleted_at = now() where id = any($1::uuid[])`,
        [hidden],
      );
      expect((await internalOrganization())?.id).toBe(internalOrg);

      await owner.query(
        `update organizations set deleted_at = now() where id = $1`,
        [internalOrg],
      );
      expect(await internalOrganization()).toBeNull();
    } finally {
      await owner.query(
        `update organizations set deleted_at = null where id = any($1::uuid[])`,
        [[...hidden, internalOrg]],
      );
    }
  });
});
