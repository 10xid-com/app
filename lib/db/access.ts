import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, inTenantTransaction } from "./connection";
import { connections, memberships, organizations, permissions } from "./schema";

/**
 * Who can see whom, and who may do what.
 *
 * These two questions turn out to be the same question asked about different
 * nouns, which is why they live together: "may Tom see John" and "may Sam
 * assign this job" are both answered by looking for a row somebody
 * deliberately created, not by inferring from a role.
 *
 * The rule underneath all of it: **nothing is visible or permitted by default.**
 * Sharing an employer grants nothing. Sharing a job grants nothing. Every
 * answer here starts at "no" and is changed only by a record of a decision.
 */

/* ------------------------------------------------------------------ */
/* Seeing                                                              */
/* ------------------------------------------------------------------ */

/** A pair is stored once, lower uuid first. Comparing text is how uuids order. */
function orderPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/**
 * Can these two people see each other?
 *
 * Three ways to yes, and they are checked in order of how expensive they are
 * to be wrong about:
 *
 *   1. They are the same person.
 *   2. They hold a live connection — in this organization, or personally.
 *      A personal connection (they scanned each other's iD) is not an
 *      organization's to grant or revoke and counts everywhere.
 *   3. The organization is `open`, and both belong to it.
 *
 * An organization being `open` does NOT write connection rows. It is evaluated
 * live, so flipping an organization to `closed` takes effect immediately
 * rather than leaving behind rows that have to be hunted down.
 */
export async function canSee(
  organizationId: string,
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  if (userId === otherUserId) return true;

  const [a, b] = orderPair(userId, otherUserId);

  const linked = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.aUserId, a),
        eq(connections.bUserId, b),
        isNull(connections.revokedAt),
        or(
          eq(connections.organizationId, organizationId),
          isNull(connections.organizationId),
        ),
      ),
    )
    .limit(1);
  if (linked.length > 0) return true;

  const open = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.memberVisibility, "open"),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);
  if (open.length === 0) return false;

  const both = await db
    .select({ n: sql<number>`count(distinct ${memberships.userId})::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        sql`${memberships.userId} in (${userId}::uuid, ${otherUserId}::uuid)`,
      ),
    );
  return (both[0]?.n ?? 0) === 2;
}

/**
 * Record that two people may see each other.
 *
 * `organizationId` null means they know each other personally — the iD-scan
 * case — and that connection outlives any employment.
 *
 * Idempotent: connecting an already-connected pair returns the existing row
 * rather than failing, because "introduce these two" being called twice is a
 * normal consequence of two people landing on a second shared job.
 */
export async function connect(input: {
  organizationId: string | null;
  userId: string;
  otherUserId: string;
  source: (typeof connections.$inferInsert)["source"];
  createdBy: string | null;
}) {
  if (input.userId === input.otherUserId) return null;
  const [aUserId, bUserId] = orderPair(input.userId, input.otherUserId);

  const rows = await db
    .insert(connections)
    .values({
      organizationId: input.organizationId,
      aUserId,
      bUserId,
      source: input.source,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return rows[0];

  const existing = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.aUserId, aUserId),
        eq(connections.bUserId, bUserId),
        isNull(connections.revokedAt),
      ),
    )
    .limit(1);
  return existing[0] ?? null;
}

/**
 * Take a connection away.
 *
 * Stamped, not deleted. "They were connected and no longer are" explains why
 * somebody can still recall work they were part of; "they never were" does
 * not, and the two would be indistinguishable after a delete.
 */
export async function disconnect(input: {
  organizationId: string | null;
  userId: string;
  otherUserId: string;
}): Promise<boolean> {
  const [aUserId, bUserId] = orderPair(input.userId, input.otherUserId);
  const rows = await db
    .update(connections)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(connections.aUserId, aUserId),
        eq(connections.bUserId, bUserId),
        isNull(connections.revokedAt),
        input.organizationId === null
          ? isNull(connections.organizationId)
          : eq(connections.organizationId, input.organizationId),
      ),
    )
    .returning({ id: connections.id });
  return rows.length === 1;
}

/* ------------------------------------------------------------------ */
/* Doing                                                               */
/* ------------------------------------------------------------------ */

export type Scope =
  | { type: "organization" }
  | { type: "department" | "task_type" | "task" | "user"; id: string };

/**
 * May this person do this thing, here?
 *
 * A capability is free text — "task.create", "task.approve", "person.see" —
 * so a new one is a row rather than a migration. That is the requirement: the
 * roles are expected to be refined indefinitely, and a permission model that
 * needs a deploy to add a verb stops being refined within the year.
 *
 * Resolution, in order:
 *
 *   1. Any live DENY that covers this scope wins outright. A deny exists so a
 *      person can be carved out of something their department was granted,
 *      without dismantling the department's grant and re-issuing it to
 *      everybody else individually.
 *   2. Otherwise any live GRANT covering this scope allows it.
 *   3. Otherwise no.
 *
 * "Covering this scope" means either a grant on the exact thing, or a grant on
 * the whole organization. Department-wide grants reaching a task inside that
 * department is the obvious next step and is deliberately NOT here yet —
 * it needs the task tables, which do not exist, and guessing the shape now
 * would be inventing a rule nobody asked for.
 */
export async function can(
  organizationId: string,
  userId: string,
  capability: string,
  scope: Scope = { type: "organization" },
): Promise<boolean> {
  const covering = and(
    eq(permissions.organizationId, organizationId),
    eq(permissions.userId, userId),
    eq(permissions.capability, capability),
    isNull(permissions.revokedAt),
    or(
      eq(permissions.scopeType, "organization"),
      scope.type === "organization"
        ? undefined
        : and(
            eq(permissions.scopeType, scope.type),
            eq(permissions.scopeId, scope.id),
          ),
    ),
  );

  /*
   * Read inside a tenant transaction, because `permissions` carries a
   * row-level security policy like any other client table. Outside a scope the
   * policy matches nothing and every answer would be a confident "no" — which
   * is the safe direction to fail, but would make the whole system look
   * broken rather than strict.
   *
   * The scope comes from the organizationId argument, so this is self
   * contained: callers do not have to remember to wrap it, and there is no
   * variant that reads permissions unscoped.
   */
  const rows = await inTenantTransaction(organizationId, false, (tx) =>
    tx.select({ deny: permissions.deny }).from(permissions).where(covering),
  );

  if (rows.length === 0) return false;
  if (rows.some((r) => r.deny)) return false;
  return true;
}

/**
 * May this person do this thing in ANY of these organizations?
 *
 * Some capabilities are held in a place rather than over a thing. "May act as
 * a staff account" is one: it belongs to the house, so the question is whether
 * the person holds it in any INTERNAL organization they are a member of, and
 * the caller supplies that list rather than this deciding what "the house"
 * means.
 *
 * It is a loop over `can()` rather than a wider query on purpose. One
 * resolution path, with the deny rule and the tenant transaction applied
 * exactly once each, is worth more than one fewer round trip — a second way to
 * answer "may they" is a second way to answer it differently.
 */
export async function canInAny(
  organizationIds: readonly string[],
  userId: string,
  capability: string,
  scope: Scope = { type: "organization" },
): Promise<boolean> {
  for (const organizationId of organizationIds) {
    if (await can(organizationId, userId, capability, scope)) return true;
  }
  return false;
}

/** Give somebody a capability. Idempotent on the live grant. */
export async function grant(input: {
  organizationId: string;
  userId: string;
  capability: string;
  scope?: Scope;
  deny?: boolean;
  grantedBy: string;
}) {
  const scope = input.scope ?? ({ type: "organization" } as Scope);
  const rows = await inTenantTransaction(input.organizationId, false, (tx) =>
    tx
    .insert(permissions)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      capability: input.capability,
      scopeType: scope.type,
      scopeId: scope.type === "organization" ? null : scope.id,
      deny: input.deny ?? false,
      grantedBy: input.grantedBy,
    })
    .onConflictDoNothing()
    .returning(),
  );
  return rows[0] ?? null;
}

/** Withdraw a capability. Stamped rather than deleted, so the history stands. */
export async function revoke(input: {
  organizationId: string;
  userId: string;
  capability: string;
  scope?: Scope;
  deny?: boolean;
}): Promise<number> {
  const scope = input.scope ?? ({ type: "organization" } as Scope);
  const rows = await inTenantTransaction(input.organizationId, false, (tx) =>
    tx
    .update(permissions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(permissions.organizationId, input.organizationId),
        eq(permissions.userId, input.userId),
        eq(permissions.capability, input.capability),
        eq(permissions.scopeType, scope.type),
        scope.type === "organization"
          ? isNull(permissions.scopeId)
          : eq(permissions.scopeId, scope.id),
        eq(permissions.deny, input.deny ?? false),
        isNull(permissions.revokedAt),
      ),
    )
    .returning({ id: permissions.id }),
  );
  return rows.length;
}
