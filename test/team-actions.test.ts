import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * The permission matrix at the door: the real server actions and the team
 * page, as each role, against the real database and the central
 * authorization function. Only the request itself is stood in for — who is
 * signed in, and the headers a browser would send — because the browser half
 * (sign-in, the handoff) is the login suite's to prove.
 *
 * Allowed and refused, both: every refusal below is paired with a person who
 * may do the same thing.
 */

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Redirect("404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/mailer", () => ({ sendInvitation: vi.fn(async () => {}) }));

const signedIn = vi.hoisted(() => ({ current: null as null | (() => unknown) }));
vi.mock("@/lib/auth/session", async (original) => ({
  ...(await original<typeof import("@/lib/auth/session")>()),
  resolveIdentity: async () => signedIn.current?.() ?? { state: "signed_out" },
}));
vi.mock("next/headers", async () => {
  const { appOrigin } = await import("@/lib/auth/origin");
  return { headers: async () => new Headers({ origin: appOrigin() ?? "" }) };
});
const pending = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/db/invitations", async (original) => {
  const real = await original<typeof import("@/lib/db/invitations")>();
  return {
    ...real,
    listInvitations: async (...args: Parameters<typeof real.listInvitations>) => {
      pending.calls += 1;
      return real.listInvitations(...args);
    },
  };
});

const { csrfTokenFor } = await import("@/lib/auth/csrf");
const { closePool } = await import("@/lib/db/connection");
const team = await import("@/app/team/actions");
const jobs = await import("@/app/jobs/actions");
const { default: TeamPage } = await import("@/app/team/page");

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `ta${Date.now().toString(36)}`;
const addr = (l: string) => `${l}-${TAG}@test.invalid`;
const SECRET = "s".repeat(43);
let org = "";
let other = "";
const people: Record<string, string> = {};

async function person(label: string, orgId: string, role: string, opts: { service?: boolean } = {}) {
  const id = (
    await owner.query("insert into users (email, is_service) values ($1, $2) returning id", [
      addr(label),
      opts.service ?? false,
    ])
  ).rows[0].id as string;
  await owner.query("insert into memberships (user_id, organization_id, role) values ($1, $2, $3)", [id, orgId, role]);
  people[label] = id;
  return id;
}

/** Sign in as `label`, on `orgId`, with whatever role the database now says they hold there. */
async function as(label: string, orgId = org) {
  const userId = people[label];
  const { rows } = await owner.query(
    `select m.role, o.name, o.slug from memberships m join organizations o on o.id = m.organization_id
      where m.user_id = $1 and m.organization_id = $2`,
    [userId, orgId],
  );
  const memberships = rows.map((r) => ({
    organizationId: orgId,
    role: r.role,
    organizationName: r.name,
    organizationSlug: r.slug,
    organizationType: "client" as const,
  }));
  const ctx = {
    sessionId: `s-${label}`,
    authSessionId: `a-${label}`,
    authUserId: `u-${label}`,
    userId,
    email: addr(label),
    fullName: null,
    role: "client",
    scope: { userId, email: addr(label), isStaff: false, organizationId: orgId, actingAs: null },
    memberships,
    absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    needsSecondFactor: false,
    realUserId: userId,
    realEmail: addr(label),
    realIsStaff: false,
    actingAs: null,
  };
  signedIn.current = () => ({ state: "active", sessionId: ctx.sessionId, csrfToken: csrfTokenFor(SECRET), ctx });
}

function form(fields: Record<string, string>) {
  const f = new FormData();
  f.set("csrf", csrfTokenFor(SECRET));
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** Where a server action sent the browser. */
async function outcome(action: (f: FormData) => Promise<unknown>, fields: Record<string, string>) {
  try {
    await action(form(fields));
    return "returned";
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
}

const roleOf = async (label: string, orgId = org) =>
  (await owner.query("select role from memberships where user_id = $1 and organization_id = $2", [people[label], orgId]))
    .rows[0]?.role ?? null;
const liveInvitation = async (email: string) =>
  (
    await owner.query(
      "select role from invitations where email = $1 and organization_id = $2 and accepted_at is null and revoked_at is null",
      [email, org],
    )
  ).rows[0]?.role ?? null;

beforeAll(async () => {
  await owner.connect();
  const make = async (n: string) =>
    (await owner.query("insert into organizations (type, name, slug) values ('client', $1, $1) returning id", [n]))
      .rows[0].id as string;
  org = await make(`${TAG}-a`);
  other = await make(`${TAG}-b`);
  await person("owner", org, "owner");
  await person("manager", org, "manager");
  await person("editor", org, "editor");
  await person("viewer", org, "viewer");
  await person("key", org, "member", { service: true });
  await person("outsider", other, "owner");
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

beforeEach(() => {
  signedIn.current = null;
});

describe("inviting", () => {
  test("an owner may invite an owner; a manager may not", async () => {
    await as("manager");
    expect(await outcome(team.inviteAction, { email: addr("new-owner"), role: "owner" })).toBe("/team?error=owner_only");
    expect(await liveInvitation(addr("new-owner"))).toBeNull();

    await as("owner");
    expect(await outcome(team.inviteAction, { email: addr("new-owner"), role: "owner" })).toBe("/team?done=invited");
    expect(await liveInvitation(addr("new-owner"))).toBe("owner");
  });

  test("a manager may invite every other role", async () => {
    await as("manager");
    for (const role of ["manager", "editor", "publisher", "asset_manager", "viewer"]) {
      const email = addr(`by-manager-${role}`);
      expect(await outcome(team.inviteAction, { email, role }), role).toBe("/team?done=invited");
      expect(await liveInvitation(email)).toBe(role);
    }
  });

  test("a manager cannot cancel an owner's invitation by re-inviting the address", async () => {
    await as("manager");
    expect(await outcome(team.inviteAction, { email: addr("new-owner"), role: "viewer" })).toBe("/team?error=owner_only");
    expect(await liveInvitation(addr("new-owner"))).toBe("owner");
  });

  test("an editor or a viewer may not invite at all", async () => {
    for (const who of ["editor", "viewer"]) {
      await as(who);
      expect(await outcome(team.inviteAction, { email: addr(`by-${who}`), role: "viewer" }), who).toBe(
        "/access?reason=role_lacks_action",
      );
      expect(await liveInvitation(addr(`by-${who}`))).toBeNull();
    }
  });

  test("a legacy role cannot be given", async () => {
    await as("owner");
    expect(await outcome(team.inviteAction, { email: addr("legacy"), role: "member" })).toBe("/team?error=email");
  });
});

describe("withdrawing an invitation", () => {
  const idOf = async (email: string) =>
    (
      await owner.query("select id from invitations where email = $1 and revoked_at is null and accepted_at is null", [
        email,
      ])
    ).rows[0].id as string;

  test("a manager may withdraw an invitation to any role but owner", async () => {
    await as("manager");
    expect(await outcome(team.revokeInvitationAction, { invitationId: await idOf(addr("new-owner")) })).toBe(
      "/team?error=owner_only",
    );
    expect(await liveInvitation(addr("new-owner"))).toBe("owner");
    expect(await outcome(team.revokeInvitationAction, { invitationId: await idOf(addr("by-manager-viewer")) })).toBe(
      "/team?done=revoked",
    );
    expect(await liveInvitation(addr("by-manager-viewer"))).toBeNull();
  });

  test("an owner may withdraw an owner's invitation", async () => {
    await as("owner");
    expect(await outcome(team.revokeInvitationAction, { invitationId: await idOf(addr("new-owner")) })).toBe(
      "/team?done=revoked",
    );
    expect(await liveInvitation(addr("new-owner"))).toBeNull();
  });

  test("an editor may not withdraw anything", async () => {
    await as("editor");
    expect(
      await outcome(team.revokeInvitationAction, { invitationId: await idOf(addr("by-manager-editor")) }),
    ).toBe("/access?reason=role_lacks_action");
    expect(await liveInvitation(addr("by-manager-editor"))).toBe("editor");
  });
});

describe("who sees pending invitations", () => {
  test("owners and managers do; editors and viewers do not", async () => {
    for (const [who, sees] of [["owner", true], ["manager", true], ["editor", false], ["viewer", false]] as const) {
      await as(who);
      pending.calls = 0;
      await TeamPage({ searchParams: Promise.resolve({}) });
      expect(pending.calls > 0, who).toBe(sees);
    }
  });
});

describe("changing and removing members", () => {
  test("a manager may change and remove people who are not owners", async () => {
    await person("temp", org, "viewer");
    await as("manager");
    expect(await outcome(team.changeRoleAction, { userId: people.temp, role: "publisher" })).toBe("/team?done=changed");
    expect(await roleOf("temp")).toBe("publisher");
    expect(await outcome(team.removeMemberAction, { userId: people.temp })).toBe("/team?done=removed");
    expect(await roleOf("temp")).toBeNull();
  });

  test("a manager may not make an owner, nor change or remove one", async () => {
    await as("manager");
    expect(await outcome(team.changeRoleAction, { userId: people.viewer, role: "owner" })).toBe("/team?error=owner_only");
    expect(await roleOf("viewer")).toBe("viewer");
    expect(await outcome(team.changeRoleAction, { userId: people.owner, role: "viewer" })).toBe("/team?error=owner_only");
    expect(await outcome(team.removeMemberAction, { userId: people.owner })).toBe("/team?error=owner_only");
    expect(await roleOf("owner")).toBe("owner");
  });

  test("an editor may change nobody", async () => {
    await as("editor");
    expect(await outcome(team.changeRoleAction, { userId: people.viewer, role: "editor" })).toBe(
      "/access?reason=role_lacks_action",
    );
    expect(await outcome(team.removeMemberAction, { userId: people.viewer })).toBe("/access?reason=role_lacks_action");
    expect(await roleOf("viewer")).toBe("viewer");
  });

  test("an integration account and somebody from another business are not on this team", async () => {
    await as("owner");
    expect(await outcome(team.removeMemberAction, { userId: people.key })).toBe("/team?error=no_member");
    expect(await outcome(team.changeRoleAction, { userId: people.outsider, role: "viewer" })).toBe("/team?error=no_member");
    expect(await outcome(team.removeMemberAction, { userId: people.outsider })).toBe("/team?error=no_member");
    expect(await roleOf("key")).toBe("member");
    expect(await roleOf("outsider", other)).toBe("owner");
  });

  test("the last owner can neither step down nor leave; with a second owner, they can", async () => {
    await as("owner");
    expect(await outcome(team.changeRoleAction, { userId: people.owner, role: "manager" })).toBe("/team?error=last_owner");
    expect(await outcome(team.removeMemberAction, { userId: people.owner })).toBe("/team?error=last_owner");
    expect(await roleOf("owner")).toBe("owner");

    expect(await outcome(team.changeRoleAction, { userId: people.manager, role: "owner" })).toBe("/team?done=changed");
    expect(await outcome(team.changeRoleAction, { userId: people.owner, role: "manager" })).toBe("/team?done=changed");
    expect(await roleOf("owner")).toBe("manager");

    // Put it back for the tests after this one.
    await as("manager");
    expect(await roleOf("manager")).toBe("owner");
    await owner.query("update memberships set role = 'owner' where user_id = $1 and organization_id = $2", [people.owner, org]);
    await owner.query("update memberships set role = 'manager' where user_id = $1 and organization_id = $2", [people.manager, org]);
  });
});

describe("job decisions", () => {
  async function jobAt(status: string) {
    const id = (
      await owner.query(
        `insert into jobs (id, organization_id, ref, title, direction, status, created_by)
         values (gen_random_uuid(), $1, $2, 'Decision test', 'from_client', $3, $4) returning id`,
        [org, `${TAG}-${Math.random().toString(36).slice(2, 7)}`, status, people.owner],
      )
    ).rows[0].id as string;
    return id;
  }
  const statusOf = async (id: string) => (await owner.query("select status from jobs where id = $1", [id])).rows[0].status;

  test("an editor may move work along, and may not approve, cancel, or complete unapproved work", async () => {
    const id = await jobAt("in_progress");
    await as("editor");
    expect(await outcome(jobs.setJobStatusAction, { jobId: id, from: "in_progress", status: "awaiting_approval" })).toBe(
      `/jobs/${id}`,
    );
    expect(await statusOf(id)).toBe("awaiting_approval");
    for (const status of ["approved", "changes_requested", "cancelled", "completed"]) {
      expect(await outcome(jobs.setJobStatusAction, { jobId: id, from: "awaiting_approval", status }), status).toBe(
        "/access?reason=role_lacks_action",
      );
    }
    expect(await statusOf(id)).toBe("awaiting_approval");
  });

  test("a manager may approve; an owner may undo it", async () => {
    const id = await jobAt("awaiting_approval");
    await as("manager");
    expect(await outcome(jobs.setJobStatusAction, { jobId: id, from: "awaiting_approval", status: "approved" })).toBe(
      `/jobs/${id}`,
    );
    expect(await statusOf(id)).toBe("approved");
    await as("owner");
    expect(await outcome(jobs.setJobStatusAction, { jobId: id, from: "approved", status: "in_progress" })).toBe(
      `/jobs/${id}`,
    );
    expect(await statusOf(id)).toBe("in_progress");
  });

  test("claiming a different starting point does not buy a cheaper permission", async () => {
    const id = await jobAt("approved");
    await as("editor");
    // approved → in_progress is a decision; the editor says the job was
    // awaiting approval, where that move would be ordinary work.
    expect(await outcome(jobs.setJobStatusAction, { jobId: id, from: "awaiting_approval", status: "in_progress" })).toBe(
      `/jobs/${id}?error=moved`,
    );
    expect(await statusOf(id)).toBe("approved");
  });

  test("a viewer may change no status", async () => {
    const id = await jobAt("open");
    await as("viewer");
    expect(await outcome(jobs.setJobStatusAction, { jobId: id, from: "open", status: "in_progress" })).toBe(
      "/access?reason=role_lacks_action",
    );
    expect(await statusOf(id)).toBe("open");
  });
});
