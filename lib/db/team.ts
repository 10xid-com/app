import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, inTenantTransaction } from "./connection";
import { invitations, memberships, users, type MembershipRole } from "./schema";

/**
 * Changing and removing the people of one business.
 *
 * The business is always the caller's (the session's), passed in by the
 * server action rather than read from a form. Who may do what is decided
 * before these are called (lib/auth/permissions.ts: canManageMember,
 * canAssignRole); what these add is the one rule the database owns — a client
 * business keeps at least one owner (login's 0024 trigger) — turned into an
 * answer rather than an exception.
 */

/**
 * `moved`: the member's role is no longer the one the decision was made on —
 * somebody changed it in between — so nothing was done. Which changes are
 * allowed depends on that role (only an owner touches an owner).
 */
export type MemberChange = "changed" | "not_found" | "moved" | "last_owner";

export type Member = {
  userId: string;
  role: MembershipRole;
  isService: boolean;
};

/** One person's membership of this business, or null. */
export async function memberOf(organizationId: string, userId: string): Promise<Member | null> {
  const [row] = await db
    .select({ userId: memberships.userId, role: memberships.role, isService: users.isService })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Live owners: real, undeleted accounts. A service account is never anybody's owner. */
export async function ownerCount(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, "owner"),
        isNull(users.deletedAt),
        eq(users.isService, false),
      ),
    );
  return row?.n ?? 0;
}

function isLastOwnerRefusal(error: unknown): boolean {
  // pg's error, possibly wrapped by drizzle as the cause.
  for (let e = error as { constraint?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.constraint === "memberships_last_owner") return true;
  }
  return false;
}

async function unchanged(organizationId: string, userId: string): Promise<MemberChange> {
  return (await memberOf(organizationId, userId)) ? "moved" : "not_found";
}

export async function changeMemberRole(
  organizationId: string,
  userId: string,
  from: MembershipRole,
  role: MembershipRole,
): Promise<MemberChange> {
  try {
    const rows = await db
      .update(memberships)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.role, from),
        ),
      )
      .returning({ id: memberships.id });
    return rows.length > 0 ? "changed" : unchanged(organizationId, userId);
  } catch (error) {
    if (isLastOwnerRefusal(error)) return "last_owner";
    throw error;
  }
}

export async function removeMember(
  organizationId: string,
  userId: string,
  from: MembershipRole,
): Promise<MemberChange> {
  try {
    const rows = await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.role, from),
        ),
      )
      .returning({ id: memberships.id });
    return rows.length > 0 ? "changed" : unchanged(organizationId, userId);
  } catch (error) {
    if (isLastOwnerRefusal(error)) return "last_owner";
    throw error;
  }
}

/** The role an outstanding invitation in this business would give, or null. */
export async function invitationRole(
  organizationId: string,
  invitationId: string,
): Promise<MembershipRole | null> {
  const [row] = await inTenantTransaction(organizationId, false, (tx) =>
    tx
      .select({ role: invitations.role })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .limit(1),
  );
  return row?.role ?? null;
}

/**
 * Whether this address has an outstanding invitation to `owner` here.
 *
 * Re-inviting an address replaces its outstanding invitation, so without
 * this a manager could cancel an owner's invitation by re-inviting the same
 * address as a viewer.
 */
export async function hasOwnerInvitation(organizationId: string, email: string): Promise<boolean> {
  const rows = await inTenantTransaction(organizationId, false, (tx) =>
    tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.email, email.trim().toLowerCase()),
          eq(invitations.role, "owner"),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}
