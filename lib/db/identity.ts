import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "./connection";
import {
  memberships,
  organizationDomains,
  organizations,
  sessions,
  signInCodes,
  ssoTickets,
  staffGrants,
  users,
} from "./schema";

/**
 * Identity queries — who someone is, and what scope their session carries.
 *
 * These are deliberately NOT tenant-scoped, and that is not an exception to the
 * rule. They are what PRODUCES a scope: you cannot look up someone's
 * memberships while already scoped to a company, any more than you can check a
 * passport while already through the gate. Each of these tables is listed in
 * scripts/check-rls.ts with that reasoning written down, so the exemption is a
 * decision on the record rather than an oversight.
 *
 * Nothing here is reachable by an id a caller supplies: sessions and tickets are
 * found by the hash of a secret only the holder has, never enumerated.
 */

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

export async function userById(id: string) {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserByEmail(email: string) {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email.toLowerCase()), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function markEmailVerified(userId: string) {
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * The companies a person belongs to, and the role they hold in each.
 *
 * Staff are identified by membership of the one internal organization — never
 * by a flag a form could set, and never by which hostname the request arrived
 * on.
 */
export async function membershipsForUser(userId: string) {
  return db
    .select({
      organizationId: memberships.organizationId,
      role: memberships.role,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      organizationType: organizations.type,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), isNull(organizations.deletedAt)));
}

/* ------------------------------------------------------------------ */
/* Sign-in codes                                                       */
/* ------------------------------------------------------------------ */

export async function recentCodeRequests(email: string, withinSeconds: number) {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signInCodes)
    .where(
      and(
        eq(signInCodes.email, email.toLowerCase()),
        gt(
          signInCodes.createdAt,
          new Date(Date.now() - withinSeconds * 1000),
        ),
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function storeSignInCode(input: {
  email: string;
  codeHash: Buffer;
  expiresAt: Date;
  requestedIp: string | null;
}) {
  await db.insert(signInCodes).values({
    email: input.email.toLowerCase(),
    codeHash: input.codeHash,
    expiresAt: input.expiresAt,
    requestedIp: input.requestedIp,
  });
}

/** The most recent unconsumed, unexpired code for this address, if any. */
export async function latestLiveCode(email: string) {
  const rows = await db
    .select()
    .from(signInCodes)
    .where(
      and(
        eq(signInCodes.email, email.toLowerCase()),
        isNull(signInCodes.consumedAt),
        gt(signInCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(signInCodes.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function countCodeAttempt(id: string) {
  await db
    .update(signInCodes)
    .set({ attempts: sql`${signInCodes.attempts} + 1` })
    .where(eq(signInCodes.id, id));
}

/**
 * Single use, enforced by the database rather than by checking first and
 * writing after. The `consumed_at IS NULL` in the WHERE clause means two
 * simultaneous redemptions produce exactly one winner; the loser gets no row
 * back and is rejected.
 */
export async function consumeSignInCode(id: string): Promise<boolean> {
  const rows = await db
    .update(signInCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(signInCodes.id, id), isNull(signInCodes.consumedAt)))
    .returning({ id: signInCodes.id });
  return rows.length === 1;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export async function insertSession(input: {
  userId: string;
  tokenHash: Buffer;
  issuedForHost: string;
  idleSeconds: number | null;
  absoluteExpiresAt: Date;
  roleAtCreation: string;
  activeOrganizationId: string | null;
}) {
  const rows = await db.insert(sessions).values(input).returning();
  return rows[0];
}

export async function sessionByTokenHash(tokenHash: Buffer) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchSession(id: string) {
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, id));
}

export async function revokeSession(id: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
}

/**
 * Signing out ends every session this person holds, on every domain.
 *
 * Each domain has its own cookie, so we cannot clear them remotely — but the
 * cookie is only a lookup key, and the row it points at is gone. The next
 * request from any domain finds nothing and is signed out. That is what makes
 * sign-out propagate immediately rather than after a token expires.
 */
export async function revokeAllSessionsForUser(userId: string) {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function activeSessionsForUser(userId: string) {
  return db
    .select({
      id: sessions.id,
      issuedForHost: sessions.issuedForHost,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      roleAtCreation: sessions.roleAtCreation,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.lastSeenAt));
}

export async function setSessionActiveOrganization(
  sessionId: string,
  organizationId: string | null,
) {
  await db
    .update(sessions)
    .set({ activeOrganizationId: organizationId })
    .where(eq(sessions.id, sessionId));
}

/* ------------------------------------------------------------------ */
/* Staff grants                                                        */
/* ------------------------------------------------------------------ */

/** The client picker staff choose from. Internal organizations are not clients. */
export async function listClientOrganizations() {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      brandPrimaryHex: organizations.brandPrimaryHex,
    })
    .from(organizations)
    .where(and(eq(organizations.type, "client"), isNull(organizations.deletedAt)))
    .orderBy(organizations.name);
}

export async function organizationById(id: string) {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createStaffGrant(input: {
  staffUserId: string;
  organizationId: string;
  reason: string;
  sessionId: string;
  expiresAt: Date;
}) {
  const rows = await db.insert(staffGrants).values(input).returning();
  return rows[0];
}

/**
 * Give up the grant.
 *
 * The row is kept — it is the audit record of which client was opened and why —
 * but its window is closed now rather than left to lapse. Clearing the
 * session's pointer alone would not be enough: the grant is what the scope is
 * derived from, so a live grant would keep the access open.
 */
export async function endGrantsForSession(sessionId: string) {
  await db
    .update(staffGrants)
    .set({ expiresAt: new Date() })
    .where(
      and(
        eq(staffGrants.sessionId, sessionId),
        gt(staffGrants.expiresAt, new Date()),
      ),
    );
}

export async function liveGrantForSession(sessionId: string) {
  const rows = await db
    .select()
    .from(staffGrants)
    .where(
      and(
        eq(staffGrants.sessionId, sessionId),
        gt(staffGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(staffGrants.grantedAt))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Domains and the cross-domain handoff                                */
/* ------------------------------------------------------------------ */

/**
 * The allowlist the handoff redeems against. A return destination is the id of
 * a row in this table — never a URL supplied by the caller — so there is no
 * address for an attacker's parser trick to exploit.
 */
export async function domainById(id: string) {
  const rows = await db
    .select()
    .from(organizationDomains)
    .where(eq(organizationDomains.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function domainByHostname(hostname: string) {
  const rows = await db
    .select({
      id: organizationDomains.id,
      hostname: organizationDomains.hostname,
      organizationId: organizationDomains.organizationId,
      organizationName: organizations.name,
      brandPrimaryHex: organizations.brandPrimaryHex,
      brandLogoUrl: organizations.brandLogoUrl,
    })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationDomains.organizationId),
    )
    .where(eq(organizationDomains.hostname, hostname.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function mintTicket(input: {
  ticketHash: Buffer;
  userId: string;
  audienceHost: string;
  returnPath: string;
  sourceSessionId: string;
  expiresAt: Date;
}) {
  const rows = await db.insert(ssoTickets).values(input).returning();
  return rows[0];
}

/**
 * Redeem exactly once, atomically, and only by the host it was minted for.
 *
 * Every condition is in the UPDATE itself rather than being checked in a
 * preceding SELECT: two simultaneous attempts produce one winner and one
 * rejection, with no window in between. A ticket presented to the wrong host,
 * after its few seconds are up, or for a second time, returns nothing —
 * indistinguishable outcomes, so a failure reveals nothing about which
 * condition failed.
 */
export async function redeemTicket(
  ticketHash: Buffer,
  audienceHost: string,
): Promise<{ userId: string; returnPath: string; sourceSessionId: string } | null> {
  const rows = await db
    .update(ssoTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(ssoTickets.ticketHash, ticketHash),
        eq(ssoTickets.audienceHost, audienceHost.toLowerCase()),
        isNull(ssoTickets.consumedAt),
        gt(ssoTickets.expiresAt, new Date()),
      ),
    )
    .returning({
      userId: ssoTickets.userId,
      returnPath: ssoTickets.returnPath,
      sourceSessionId: ssoTickets.sourceSessionId,
    });
  return rows[0] ?? null;
}

/** Sign-out kills tickets still in flight, not just established sessions. */
export async function consumeTicketsForSession(sessionId: string) {
  await db
    .update(ssoTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(ssoTickets.sourceSessionId, sessionId),
        isNull(ssoTickets.consumedAt),
      ),
    );
}
