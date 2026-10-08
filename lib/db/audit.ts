import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db, inTenantTransaction, type Transaction } from "./connection";
import { auditEvents, users } from "./schema";

/**
 * The audit record (login's 0025, audit_events): append-only, and each row
 * visible only to its own business — row-level security on app.org_id, the
 * same as every other tenant table. The portal can add rows and read its own
 * business's; it cannot change or remove one.
 *
 * What is recorded:
 *   agency.grant.*     a request, an approval, a decline, an end, a withdrawal
 *   agency.person.*    a person named, approved, declined, blocked, unblocked,
 *                      taken off
 *   agency.acted       a state-changing request made through agency access
 *                      (target: the action), in the business it reached
 *
 * Decisions a business makes are recorded in that business; what an agency
 * does (asking, naming, taking off, withdrawing) in the agency AND the
 * business, so each can see what the other did about it.
 */

export type AuditEntry = {
  organizationId: string;
  actorUserId: string | null;
  agencyGrantId?: string | null;
  action: string;
  target?: string | null;
};

/**
 * Write entries inside a transaction that is already open, switching
 * app.org_id for each (set_config(..., true) lasts until the transaction
 * ends), so the rows commit or roll back with the change they describe.
 */
export async function writeAudit(tx: Transaction, entries: AuditEntry[]): Promise<void> {
  for (const e of entries) {
    await tx.execute(sql`select set_config('app.org_id', ${e.organizationId}, true)`);
    await tx.insert(auditEvents).values({
      organizationId: e.organizationId,
      actorUserId: e.actorUserId,
      agencyGrantId: e.agencyGrantId ?? null,
      action: e.action,
      target: e.target ?? null,
    });
  }
}

/** Entries on their own, for something with no transaction of its own to join. */
export async function recordAudit(entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.transaction((tx) => writeAudit(tx, entries));
}

export type AuditRow = {
  id: bigint;
  action: string;
  target: string | null;
  agencyGrantId: string | null;
  actorEmail: string | null;
  createdAt: Date;
};

/** The latest of one business's entries, newest first. */
export async function auditFor(organizationId: string, limit = 50): Promise<AuditRow[]> {
  return inTenantTransaction(organizationId, false, (tx) =>
    tx
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        target: auditEvents.target,
        agencyGrantId: auditEvents.agencyGrantId,
        actorEmail: users.email,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(eq(auditEvents.organizationId, organizationId))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit),
  );
}
