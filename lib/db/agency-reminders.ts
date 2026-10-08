import "server-only";
import { sql } from "drizzle-orm";
import { db } from "./connection";
import { writeAudit } from "./audit";

/**
 * Expiry reminders for agency access (login's 0026, agency_grant_reminders).
 *
 * Seven days before a grant ends, each owner of the business and each owner of
 * the agency is told once. "Once" is the database's: a reminder is CLAIMED
 * (one row per grant, person and kind, unique) before it is sent, so however
 * often the run starts, and however many runs overlap, nobody is told twice.
 * A send that fails is recorded and tried again on the next run, at most five
 * times in all. A claim left mid-send (the run died) is never retried: the
 * message may have gone.
 */

export const REMINDER_DAYS = 7;
export const REMINDER_MAX_ATTEMPTS = 5;

export type ReminderRecipient = { userId: string; email: string; side: "client" | "agency" };

export type DueReminder = {
  grantId: string;
  clientId: string;
  clientName: string;
  agencyId: string;
  agencyName: string;
  role: string;
  expiresAt: Date;
  recipients: ReminderRecipient[];
};

/**
 * Grants whose end falls within the next seven days and who should hear
 * about it.
 *
 * In force only: approved, not revoked, not yet ended. A grant that a later
 * approved renewal already outlasts is left alone — there is nothing to
 * renew. Both organizations must still be live, and the agency still an
 * agency; otherwise the access is already gone. Recipients are the owners of
 * each side, live people, never service accounts.
 */
export async function dueExpiryReminders(): Promise<DueReminder[]> {
  const result = await db.execute<{
    grant_id: string;
    client_id: string;
    client_name: string;
    agency_id: string;
    agency_name: string;
    role: string;
    expires_at: Date | string;
    user_id: string;
    email: string;
    side: "client" | "agency";
  }>(sql`
    with due as (
      select g.id, g.client_organization_id, g.agency_organization_id, g.role, g.expires_at,
             c.name as client_name, a.name as agency_name
        from agency_grants g
        join organizations c on c.id = g.client_organization_id and c.deleted_at is null and c.type = 'client'
        join organizations a on a.id = g.agency_organization_id and a.deleted_at is null and a.is_agency
       where g.status = 'active'
         and g.expires_at > now()
         and g.expires_at <= now() + make_interval(days => ${REMINDER_DAYS})
         and not exists (
           select 1 from agency_grants later
            where later.client_organization_id = g.client_organization_id
              and later.agency_organization_id = g.agency_organization_id
              and later.status = 'active'
              and later.expires_at > g.expires_at)
    )
    select due.id as grant_id, due.client_organization_id as client_id, due.client_name,
           due.agency_organization_id as agency_id, due.agency_name, due.role::text as role, due.expires_at,
           u.id as user_id, u.email, side.side
      from due
      cross join lateral (values ('client', due.client_organization_id), ('agency', due.agency_organization_id))
           as side(side, organization_id)
      join memberships m on m.organization_id = side.organization_id and m.role = 'owner'
      join users u on u.id = m.user_id and u.deleted_at is null and not u.is_service
     order by due.expires_at, due.id, side.side, u.email
  `);
  const byGrant = new Map<string, DueReminder>();
  for (const r of result.rows) {
    let due = byGrant.get(r.grant_id);
    if (!due) {
      due = {
        grantId: r.grant_id,
        clientId: r.client_id,
        clientName: r.client_name,
        agencyId: r.agency_id,
        agencyName: r.agency_name,
        role: r.role,
        expiresAt: new Date(r.expires_at),
        recipients: [],
      };
      byGrant.set(r.grant_id, due);
    }
    due.recipients.push({ userId: r.user_id, email: r.email, side: r.side });
  }
  return [...byGrant.values()];
}

/**
 * Claim the reminder for one person about one grant: a new claim, or another
 * try at one that failed (counted, up to the limit). Anything else — already
 * sent, mid-send elsewhere, out of tries — is null, and nothing is sent.
 */
export async function claimReminder(grantId: string, userId: string): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    insert into agency_grant_reminders (grant_id, user_id, kind)
    values (${grantId}, ${userId}, 'expiry_7d')
    on conflict on constraint agency_grant_reminders_once do update
       set status = 'sending', attempts = agency_grant_reminders.attempts + 1, last_error = null
     where agency_grant_reminders.status = 'failed'
       and agency_grant_reminders.attempts < ${REMINDER_MAX_ATTEMPTS}
    returning id
  `);
  return result.rows[0]?.id ?? null;
}

/**
 * How the send went. A sent reminder also goes on the audit record of the
 * side it was sent to, so the business (or the agency) can see it was told.
 */
export async function recordReminder(
  claimId: string,
  outcome: { sent: true; organizationId: string; grantId: string; userId: string } | { sent: false; error: string },
): Promise<void> {
  if (!outcome.sent) {
    await db.execute(sql`
      update agency_grant_reminders set status = 'failed', last_error = ${outcome.error.slice(0, 500)} where id = ${claimId}
    `);
    return;
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`update agency_grant_reminders set status = 'sent' where id = ${claimId}`);
    await writeAudit(tx, [
      {
        organizationId: outcome.organizationId,
        actorUserId: null,
        agencyGrantId: outcome.grantId,
        action: "agency.grant.expiry_reminded",
        target: outcome.userId,
      },
    ]);
  });
}
