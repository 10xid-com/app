import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { createJob, getJob, setJobStatus, type Scope } from "@/lib/db";
import { closePool } from "@/lib/db/connection";
import { inviteToOrganization } from "@/lib/db/invitations";
import {
  changeMemberRole,
  hasOwnerInvitation,
  invitationRole,
  memberOf,
  ownerCount,
  removeMember,
} from "@/lib/db/team";

/**
 * Changing and removing a business's people, through the application's own
 * role (portal_app), with login's 0024 guard underneath: a client business is
 * never left without an owner, and the refusal comes back as an answer.
 *
 * And a job's status is only changed from the status the person was looking
 * at, because which moves are allowed depends on it.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `tm${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
let org = "";
let other = "";

async function person(label: string, orgId: string, role: string, opts: { service?: boolean } = {}) {
  const id = (
    await owner.query("insert into users (email, is_service) values ($1, $2) returning id", [
      addr(label),
      opts.service ?? false,
    ])
  ).rows[0].id as string;
  await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, $3)", [id, orgId, role]);
  return id;
}

beforeAll(async () => {
  await owner.connect();
  const make = async (n: string) =>
    (await owner.query("insert into organizations (type, name, slug) values ('client', $1, $1) returning id", [n]))
      .rows[0].id as string;
  org = await make(`${TAG}-a`);
  other = await make(`${TAG}-b`);
});

afterAll(async () => {
  await owner.query("delete from job_events where organization_id = any($1::uuid[])", [[org, other]]).catch(() => {});
  await owner.query("delete from jobs where organization_id = any($1::uuid[])", [[org, other]]);
  await owner.query("delete from invitations where organization_id = any($1::uuid[])", [[org, other]]);
  await owner.query("delete from memberships where organization_id = any($1::uuid[])", [[org, other]]);
  await owner.query("delete from user_emails where email like $1", [`%-${TAG}@test.invalid`]);
  await owner.query("delete from users where email like $1", [`%-${TAG}@test.invalid`]);
  await owner.query("delete from organizations where id = any($1::uuid[])", [[org, other]]);
  await owner.end();
  await closePool();
});

describe("the people of one business", () => {
  test("a role is changed, and a member removed, in this business only, from the role it was decided on", async () => {
    await person("boss", org, "owner");
    const v = await person("v", org, "viewer");
    expect(await changeMemberRole(other, v, "viewer", "editor")).toBe("not_found");
    expect(await changeMemberRole(org, v, "viewer", "editor")).toBe("changed");
    expect((await memberOf(org, v))?.role).toBe("editor");
    expect(await removeMember(other, v, "editor")).toBe("not_found");
    expect(await removeMember(org, v, "viewer")).toBe("moved");
    expect(await removeMember(org, v, "editor")).toBe("changed");
    expect(await memberOf(org, v)).toBeNull();
  });

  test("the last owner can be neither demoted nor removed", async () => {
    const solo = (
      await owner.query("insert into organizations (type, name, slug) values ('client', $1, $1) returning id", [
        `${TAG}-solo`,
      ])
    ).rows[0].id as string;
    try {
      const only = await person("only", solo, "owner");
      await person("key", solo, "owner", { service: true });
      expect(await ownerCount(solo)).toBe(1);
      expect(await changeMemberRole(solo, only, "owner", "manager")).toBe("last_owner");
      expect(await removeMember(solo, only, "owner")).toBe("last_owner");
      expect((await memberOf(solo, only))?.role).toBe("owner");

      const second = await person("second", solo, "owner");
      expect(await ownerCount(solo)).toBe(2);
      expect(await changeMemberRole(solo, only, "owner", "manager")).toBe("changed");
      expect(await removeMember(solo, second, "owner")).toBe("last_owner");
    } finally {
      await owner.query("delete from memberships where organization_id = $1", [solo]);
      await owner.query("delete from organizations where id = $1", [solo]);
    }
  });

  test("a service account is reported as one", async () => {
    const key = await person("svc", org, "member", { service: true });
    expect(await memberOf(org, key)).toMatchObject({ role: "member", isService: true });
  });
});

describe("invitations to owner", () => {
  test("are found by address, in this business only", async () => {
    const inviter = await person("inviter", org, "owner");
    const { id } = await inviteToOrganization({
      organizationId: org,
      email: addr("future-owner").toUpperCase(),
      role: "owner",
      invitedBy: inviter,
    });
    expect(await hasOwnerInvitation(org, addr("future-owner"))).toBe(true);
    expect(await hasOwnerInvitation(other, addr("future-owner"))).toBe(false);
    expect(await invitationRole(org, id)).toBe("owner");
    expect(await invitationRole(other, id)).toBeNull();

    await inviteToOrganization({ organizationId: org, email: addr("plain"), role: "viewer", invitedBy: inviter });
    expect(await hasOwnerInvitation(org, addr("plain"))).toBe(false);
  });
});

describe("a job's status changes only from where the person saw it", () => {
  test("a change made against a status that has moved on is not applied", async () => {
    const userId = await person("filer", org, "editor");
    const scope: Scope = { userId, email: addr("filer"), isStaff: false, organizationId: org };
    const job = await createJob(scope, { title: "Status test", direction: "from_client", dueAt: null });

    expect(await setJobStatus(scope, job.id, "in_progress", "open")).toMatchObject({ status: "in_progress" });
    // Somebody else's view still says "open".
    expect(await setJobStatus(scope, job.id, "awaiting_approval", "open")).toBeNull();
    expect((await getJob(scope, job.id))?.status).toBe("in_progress");
    // Another business's scope cannot see it at all.
    expect(await setJobStatus({ ...scope, organizationId: other }, job.id, "approved", "in_progress")).toBeNull();
    expect((await getJob(scope, job.id))?.status).toBe("in_progress");
  });
});
