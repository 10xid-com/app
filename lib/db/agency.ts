import "server-only";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Transaction } from "./connection";
import { type AuditEntry, writeAudit } from "./audit";
import { agencyGrantPeople, agencyGrants, memberships, organizations, users } from "./schema";

/**
 * Agency access a person holds right now — read, like memberships, before any
 * scope exists, because it is one of the things that PRODUCES the scope.
 *
 * Live means all of these, checked on every request:
 *   * the grant is in force (approved, not revoked) and its date has not come;
 *   * this person is on it and approved — not requested, blocked or removed;
 *   * they are still a member of the agency, and the agency is still an
 *     agency and not deleted;
 *   * the business is a live client business.
 *
 * Drop any one and the business is off their screen on the next click. The
 * rules about who may change any of this are the database's (login's 0025).
 */
export type AgencyAccess = {
  grantId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  agencyOrganizationId: string;
  agencyName: string;
  role: string;
  expiresAt: Date;
};

const client = alias(organizations, "client");
const agency = alias(organizations, "agency");

export async function liveAgencyAccessFor(userId: string): Promise<AgencyAccess[]> {
  const rows = await db
    .select({
      grantId: agencyGrants.id,
      organizationId: client.id,
      organizationName: client.name,
      organizationSlug: client.slug,
      agencyOrganizationId: agency.id,
      agencyName: agency.name,
      role: agencyGrants.role,
      expiresAt: agencyGrants.expiresAt,
    })
    .from(agencyGrantPeople)
    .innerJoin(agencyGrants, eq(agencyGrants.id, agencyGrantPeople.grantId))
    .innerJoin(client, eq(client.id, agencyGrants.clientOrganizationId))
    .innerJoin(agency, eq(agency.id, agencyGrants.agencyOrganizationId))
    .innerJoin(
      memberships,
      and(eq(memberships.organizationId, agency.id), eq(memberships.userId, agencyGrantPeople.userId)),
    )
    .where(
      and(
        eq(agencyGrantPeople.userId, userId),
        eq(agencyGrantPeople.status, "approved"),
        eq(agencyGrants.status, "active"),
        gt(agencyGrants.expiresAt, sql`now()`),
        eq(client.type, "client"),
        isNull(client.deletedAt),
        eq(agency.isAgency, true),
        isNull(agency.deletedAt),
        inArray(memberships.role, ["owner", "manager", "editor", "publisher", "asset_manager", "viewer"]),
      ),
    );
  return rows.map((r) => ({ ...r, expiresAt: r.expiresAt! }));
}

/* ------------------------------------------------------------------ */
/* Managing grants. Every write names the business the session is on   */
/* in its WHERE clause, so an id from another business changes nothing; */
/* who may do what is the central function's, then login's 0025 rules.  */
/* ------------------------------------------------------------------ */

export type GrantPerson = {
  userId: string;
  email: string;
  fullName: string | null;
  status: "requested" | "approved" | "declined" | "blocked" | "removed";
};

export type GrantSummary = {
  id: string;
  otherOrganizationId: string;
  otherName: string;
  role: string;
  status: "requested" | "active" | "declined" | "revoked";
  reason: string;
  durationDays: number;
  requestedAt: Date;
  expiresAt: Date | null;
  /** In force right now: approved, not ended, before its date — by the database's clock. */
  live: boolean;
  people: GrantPerson[];
};

/** A refusal from 0025's rules, as an answer rather than an exception. */
export type GrantOutcome = "done" | "not_found" | "refused" | "already_open";

function refusal(error: unknown): GrantOutcome | null {
  for (let e = error as { code?: string; constraint?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.constraint === "agency_grants_one_open_idx" || e.constraint === "agency_grant_people_once") return "already_open";
    if (e.code === "23514" || e.code === "23503" || e.code === "23505") return "refused";
  }
  return null;
}

/**
 * One change and its audit entries, in one transaction: the entries are
 * written only if the change touched a row, and roll back with it.
 */
async function attempt(fn: (tx: Transaction) => Promise<number>, audit: AuditEntry[]): Promise<GrantOutcome> {
  try {
    return await db.transaction(async (tx) => {
      if ((await fn(tx)) === 0) return "not_found";
      await writeAudit(tx, audit);
      return "done";
    });
  } catch (error) {
    const r = refusal(error);
    if (r) return r;
    throw error;
  }
}

async function peopleOf(grantIds: string[]): Promise<Map<string, GrantPerson[]>> {
  const out = new Map<string, GrantPerson[]>();
  if (grantIds.length === 0) return out;
  const rows = await db
    .select({
      grantId: agencyGrantPeople.grantId,
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      status: agencyGrantPeople.status,
    })
    .from(agencyGrantPeople)
    .innerJoin(users, eq(users.id, agencyGrantPeople.userId))
    .where(inArray(agencyGrantPeople.grantId, grantIds))
    .orderBy(users.email);
  for (const r of rows) {
    const list = out.get(r.grantId) ?? [];
    list.push({ userId: r.userId, email: r.email, fullName: r.fullName, status: r.status });
    out.set(r.grantId, list);
  }
  return out;
}

async function grantsWhere(side: "client" | "agency", organizationId: string): Promise<GrantSummary[]> {
  const mine = side === "client" ? agencyGrants.clientOrganizationId : agencyGrants.agencyOrganizationId;
  const theirs = side === "client" ? agencyGrants.agencyOrganizationId : agencyGrants.clientOrganizationId;
  const rows = await db
    .select({
      id: agencyGrants.id,
      otherOrganizationId: organizations.id,
      otherName: organizations.name,
      role: agencyGrants.role,
      status: agencyGrants.status,
      reason: agencyGrants.reason,
      durationDays: agencyGrants.durationDays,
      requestedAt: agencyGrants.requestedAt,
      expiresAt: agencyGrants.expiresAt,
      live: sql<boolean>`(${agencyGrants.status} = 'active' and ${agencyGrants.expiresAt} > now())`,
    })
    .from(agencyGrants)
    .innerJoin(organizations, eq(organizations.id, theirs))
    .where(eq(mine, organizationId))
    .orderBy(desc(agencyGrants.requestedAt))
    .limit(50);
  const people = await peopleOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, people: people.get(r.id) ?? [] }));
}

/** Agency access asked of, or granted by, this business. */
export const grantsForBusiness = (businessId: string) => grantsWhere("client", businessId);
/** Access this agency has asked for or holds. */
export const grantsForAgency = (agencyId: string) => grantsWhere("agency", agencyId);

/* ---- The agency's side ---- */

/**
 * Ask a business for access, by its reference (the slug its people can give
 * you). Whether the reference exists is not revealed to the asker beyond
 * "asked": the caller shows one message either way.
 */
export async function requestGrant(input: {
  agencyId: string;
  businessRef: string;
  role: string;
  durationDays: number;
  reason: string;
  requestedBy: string;
}): Promise<{ outcome: GrantOutcome; grantId?: string; businessId?: string }> {
  const [business] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.slug, input.businessRef.trim().toLowerCase()), eq(organizations.type, "client"), isNull(organizations.deletedAt)))
    .limit(1);
  if (!business || business.id === input.agencyId) return { outcome: "not_found" };
  try {
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
      .insert(agencyGrants)
      .values({
        clientOrganizationId: business.id,
        agencyOrganizationId: input.agencyId,
        role: input.role as typeof agencyGrants.$inferInsert.role,
        durationDays: input.durationDays,
        reason: input.reason,
        requestedBy: input.requestedBy,
      })
      .returning({ id: agencyGrants.id });
      const entry = { actorUserId: input.requestedBy, agencyGrantId: inserted.id, action: "agency.grant.requested", target: input.role };
      await writeAudit(tx, [
        { ...entry, organizationId: input.agencyId },
        { ...entry, organizationId: business.id },
      ]);
      return inserted;
    });
    return { outcome: "done", grantId: row.id, businessId: business.id };
  } catch (error) {
    const r = refusal(error);
    if (r) return { outcome: r };
    throw error;
  }
}

/** Name one of the agency's own people on one of its open grants. */
export async function addGrantPerson(agencyId: string, grantId: string, userId: string, addedBy: string): Promise<GrantOutcome> {
  const g = await grantOwnedBy("agency", agencyId, grantId);
  if (!g) return "not_found";
  return attempt(
    async (tx) => {
      const rows = await tx.insert(agencyGrantPeople).values({ grantId, userId, addedBy }).returning({ id: agencyGrantPeople.id });
      return rows.length;
    },
    bothSides(g, { actorUserId: addedBy, agencyGrantId: grantId, action: "agency.person.named", target: userId }),
  );
}

/** The grant, if it belongs to that organization on that side. */
async function grantOwnedBy(side: "client" | "agency", organizationId: string, grantId: string) {
  const owned = side === "client" ? agencyGrants.clientOrganizationId : agencyGrants.agencyOrganizationId;
  const [g] = await db
    .select({ id: agencyGrants.id, clientId: agencyGrants.clientOrganizationId, agencyId: agencyGrants.agencyOrganizationId })
    .from(agencyGrants)
    .where(and(eq(agencyGrants.id, grantId), eq(owned, organizationId)))
    .limit(1);
  return g ?? null;
}

type Unplaced = Omit<AuditEntry, "organizationId">;
const bothSides = (g: { clientId: string; agencyId: string }, e: Unplaced): AuditEntry[] => [
  { ...e, organizationId: g.agencyId },
  { ...e, organizationId: g.clientId },
];

/** Take a person off one of the agency's grants. */
export async function removeGrantPerson(agencyId: string, grantId: string, userId: string, by: string): Promise<GrantOutcome> {
  return setPersonStatus({ side: "agency", organizationId: agencyId }, grantId, userId, "removed", by);
}

/** Withdraw a request, or end access the agency holds. */
export async function withdrawGrant(agencyId: string, grantId: string, by: string): Promise<GrantOutcome> {
  const g = await grantOwnedBy("agency", agencyId, grantId);
  if (!g) return "not_found";
  return attempt(
    async (tx) => {
      const rows = await tx
        .update(agencyGrants)
        .set({ status: "revoked", revokedBy: by })
        .where(and(eq(agencyGrants.id, grantId), eq(agencyGrants.agencyOrganizationId, agencyId)))
        .returning({ id: agencyGrants.id });
      return rows.length;
    },
    bothSides(g, { actorUserId: by, agencyGrantId: grantId, action: "agency.grant.withdrawn" }),
  );
}

/* ---- The business's side ---- */

export async function approveGrant(
  businessId: string,
  grantId: string,
  by: string,
  role: string,
  days: number,
): Promise<GrantOutcome> {
  return attempt(
    async (tx) => {
      const rows = await tx
        .update(agencyGrants)
        .set({
          status: "active",
          decidedBy: by,
          role: role as typeof agencyGrants.$inferInsert.role,
          expiresAt: sql`now() + make_interval(days => ${days})`,
        })
        .where(and(eq(agencyGrants.id, grantId), eq(agencyGrants.clientOrganizationId, businessId), eq(agencyGrants.status, "requested")))
        .returning({ id: agencyGrants.id });
      return rows.length;
    },
    [{ organizationId: businessId, actorUserId: by, agencyGrantId: grantId, action: "agency.grant.approved", target: `${role}, ${days} days` }],
  );
}

export async function declineGrant(businessId: string, grantId: string, by: string): Promise<GrantOutcome> {
  return attempt(
    async (tx) => {
      const rows = await tx
        .update(agencyGrants)
        .set({ status: "declined", decidedBy: by })
        .where(and(eq(agencyGrants.id, grantId), eq(agencyGrants.clientOrganizationId, businessId), eq(agencyGrants.status, "requested")))
        .returning({ id: agencyGrants.id });
      return rows.length;
    },
    [{ organizationId: businessId, actorUserId: by, agencyGrantId: grantId, action: "agency.grant.declined" }],
  );
}

export async function revokeGrant(businessId: string, grantId: string, by: string): Promise<GrantOutcome> {
  return attempt(
    async (tx) => {
      const rows = await tx
        .update(agencyGrants)
        .set({ status: "revoked", revokedBy: by })
        .where(and(eq(agencyGrants.id, grantId), eq(agencyGrants.clientOrganizationId, businessId)))
        .returning({ id: agencyGrants.id });
      return rows.length;
    },
    [{ organizationId: businessId, actorUserId: by, agencyGrantId: grantId, action: "agency.grant.revoked" }],
  );
}

export type PersonDecision = "approved" | "declined" | "blocked" | "removed";

export async function decideGrantPerson(
  businessId: string,
  grantId: string,
  userId: string,
  status: Exclude<PersonDecision, "removed">,
  by: string,
): Promise<GrantOutcome> {
  return setPersonStatus({ side: "client", organizationId: businessId }, grantId, userId, status, by);
}

async function setPersonStatus(
  where: { side: "client" | "agency"; organizationId: string },
  grantId: string,
  userId: string,
  status: PersonDecision,
  by: string,
): Promise<GrantOutcome> {
  const g = await grantOwnedBy(where.side, where.organizationId, grantId);
  if (!g) return "not_found";
  const entry = { actorUserId: by, agencyGrantId: grantId, action: `agency.person.${status}`, target: userId };
  return attempt(
    async (tx) => {
      const rows = await tx
        .update(agencyGrantPeople)
        .set({ status, decidedBy: by })
        .where(and(eq(agencyGrantPeople.grantId, grantId), eq(agencyGrantPeople.userId, userId)))
        .returning({ id: agencyGrantPeople.id });
      return rows.length;
    },
    // The business's decisions in the business; the agency taking somebody off, in both.
    where.side === "client" ? [{ ...entry, organizationId: g.clientId }] : bothSides(g, entry),
  );
}

/** The agency's members who could be named on a grant (people, not integrations). */
export async function agencyPeople(agencyId: string) {
  return db
    .select({ userId: users.id, email: users.email, fullName: users.fullName })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, agencyId), isNull(users.deletedAt), eq(users.isService, false)))
    .orderBy(users.email);
}

/** Owners of a business, for telling them a decision is waiting. */
export async function ownerEmailsOf(businessId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, businessId), eq(memberships.role, "owner"), isNull(users.deletedAt), eq(users.isService, false)));
  return rows.map((r) => r.email);
}
