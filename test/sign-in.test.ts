import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { closePool } from "@/lib/db/connection";
import { inviteToOrganization } from "@/lib/db/invitations";
import { resolveSignIn } from "@/lib/auth/sign-in";
import { openBindingFor, userByWorkosId } from "@/lib/db/workos";

/**
 * What a WorkOS sign-in means locally (lib/auth/sign-in.ts), against the real
 * database and as the application's restricted role.
 *
 * The rules being pinned (Revision 2, and Paolo's decisions of 2026-10-07):
 * an address match never grants access by itself; an invitation made out to
 * exactly the verified address creates a bound account; an account from
 * before WorkOS asks an operator and waits.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `si${Date.now().toString(36)}`;
const made: string[] = [];
let orgId = "";
let legacyId = "";
let inviterId = "";

const addr = (label: string) => `${label}-${TAG}@test.invalid`;
const workos = (label: string) => `user_${TAG}_${label}`;

beforeAll(async () => {
  await owner.connect();
  const org = await owner.query(
    "insert into organizations (type, name, slug) values ('client', $1, $1) returning id",
    [`org-${TAG}`],
  );
  orgId = org.rows[0].id;
  const users = await owner.query(
    `insert into users (email, is_service) values ($1, false), ($2, false), ($3, true) returning id, email`,
    [addr("legacy"), addr("inviter"), addr("service")],
  );
  for (const r of users.rows) made.push(r.id);
  legacyId = users.rows.find((r) => r.email === addr("legacy")).id;
  inviterId = users.rows.find((r) => r.email === addr("inviter")).id;
  await owner.query(
    "insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')",
    [legacyId, orgId],
  );
});

afterAll(async () => {
  const ids = (
    await owner.query("select id from users where email like $1", [`%-${TAG}@test.invalid`])
  ).rows.map((r) => r.id);
  await owner.query("delete from identity_bindings where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from memberships where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from invitations where organization_id = $1", [orgId]);
  await owner.query("delete from user_emails where user_id = any($1::uuid[])", [ids]);
  await owner.query("delete from users where id = any($1::uuid[])", [ids]);
  await owner.query("delete from organizations where id = $1", [orgId]);
  await owner.end();
  await closePool();
});

describe("an account from before WorkOS", () => {
  test("is not bound by its address: it asks an operator, once", async () => {
    const who = { id: workos("legacy"), email: `  ${addr("legacy").toUpperCase()} `, emailVerified: true };

    expect(await resolveSignIn(who)).toBe("binding_requested");
    expect(await resolveSignIn(who)).toBe("binding_requested");

    expect(await userByWorkosId(who.id)).toBeNull();
    const open = await openBindingFor(who.id);
    expect(open?.userId).toBe(legacyId);
    expect(open?.email).toBe(addr("legacy"));
    const count = await owner.query("select count(*)::int as n from identity_bindings where user_id = $1", [legacyId]);
    expect(count.rows[0].n).toBe(1);
  });

  test("once an operator binds it, the same sign-in is simply bound", async () => {
    await owner.query("update users set workos_user_id = $2 where id = $1", [legacyId, workos("legacy")]);
    expect(await resolveSignIn({ id: workos("legacy"), email: addr("legacy"), emailVerified: true })).toBe("bound");
    expect((await userByWorkosId(workos("legacy")))?.id).toBe(legacyId);
  });

  test("a different WorkOS user with the same address is a conflict, not a second binding", async () => {
    expect(await resolveSignIn({ id: workos("intruder"), email: addr("legacy"), emailVerified: true })).toBe(
      "conflict",
    );
    expect(await openBindingFor(workos("intruder"))).toBeNull();
  });
});

describe("an invitation", () => {
  test("accepted by exactly its verified address, creates a bound account with its role", async () => {
    await inviteToOrganization({ organizationId: orgId, email: addr("new"), role: "editor", invitedBy: inviterId });
    expect(await resolveSignIn({ id: workos("new"), email: addr("new"), emailVerified: true })).toBe(
      "invitation_accepted",
    );

    const account = await userByWorkosId(workos("new"));
    expect(account?.email).toBe(addr("new"));
    const membership = await owner.query("select role from memberships where user_id = $1 and organization_id = $2", [
      account!.id,
      orgId,
    ]);
    expect(membership.rows[0].role).toBe("editor");

    // Used once: the next sign-in is just "bound".
    expect(await resolveSignIn({ id: workos("new"), email: addr("new"), emailVerified: true })).toBe("bound");
  });

  test("is not accepted by an unverified address", async () => {
    await inviteToOrganization({ organizationId: orgId, email: addr("unverified"), role: "owner", invitedBy: inviterId });
    expect(await resolveSignIn({ id: workos("unverified"), email: addr("unverified"), emailVerified: false })).toBe(
      "unverified",
    );
    expect(await userByWorkosId(workos("unverified"))).toBeNull();
  });

  test("is not accepted by another address at the same domain", async () => {
    await inviteToOrganization({ organizationId: orgId, email: addr("named"), role: "owner", invitedBy: inviterId });
    expect(await resolveSignIn({ id: workos("colleague"), email: addr("colleague"), emailVerified: true })).toBe(
      "no_access",
    );
    expect(await userByWorkosId(workos("colleague"))).toBeNull();
  });
});

describe("everybody else", () => {
  test("a stranger gets nothing", async () => {
    expect(await resolveSignIn({ id: workos("stranger"), email: addr("stranger"), emailVerified: true })).toBe(
      "no_access",
    );
  });

  test("a service account's address cannot be signed in to", async () => {
    expect(await resolveSignIn({ id: workos("svc"), email: addr("service"), emailVerified: true })).toBe("no_access");
    expect(await openBindingFor(workos("svc"))).toBeNull();
  });
});
