import "server-only";
import { ROLE_LABELS, isRoleTemplate } from "@/lib/auth/permissions";
import { appOrigin } from "@/lib/auth/origin";
import { sendExpiryReminder } from "@/lib/auth/mailer";
import {
  claimReminder,
  dueExpiryReminders,
  recordReminder,
  type DueReminder,
  type ReminderRecipient,
} from "@/lib/db/agency-reminders";

/**
 * The daily expiry-reminder run: seven days before agency access ends, the
 * business's owners and the agency's owners are each told once (login's
 * 0026 makes "once" the database's rule), with the end date and a link to
 * the grant.
 *
 * Nothing renews by itself. The business is told it need do nothing for the
 * access to end; the agency is told that continuing means asking to renew,
 * which the business's owner decides on, person by person, like the first
 * time.
 *
 * Started by POST /api/v1/cron/agency-reminders on a schedule. Overlapping
 * or repeated runs are harmless; a failed send is retried by the next run.
 */

export type ReminderEmail = { subject: string; text: string };

const roleName = (r: string) => (isRoleTemplate(r) ? ROLE_LABELS[r] : r);
const endDate = (d: Date) =>
  d.toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "long", timeStyle: "short" }) + " UTC";

/** The link in every reminder: the grant itself, which opens on the right side. */
export function grantUrl(grantId: string): string {
  return `${appOrigin() ?? ""}/grants/${grantId}`;
}

export function reminderEmail(due: DueReminder, side: ReminderRecipient["side"]): ReminderEmail {
  const when = endDate(due.expiresAt);
  const role = roleName(due.role);
  if (side === "client") {
    return {
      subject: `${due.agencyName}'s access to ${due.clientName} ends on ${when}`,
      text: [
        `${due.agencyName} has ${role} access to ${due.clientName} on 10XiD. It ends on ${when}.`,
        ``,
        `Nothing renews by itself. If you do nothing, the access ends then.`,
        `If ${due.agencyName} asks to renew, nothing changes until an owner of ${due.clientName} approves the renewal and each of their people again.`,
        ``,
        `See the grant, who is on it, or end it sooner (sign in first):`,
        `  ${grantUrl(due.grantId)}`,
      ].join("\n"),
    };
  }
  return {
    subject: `Your access to ${due.clientName} ends on ${when}`,
    text: [
      `${due.agencyName}'s ${role} access to ${due.clientName} on 10XiD ends on ${when}.`,
      ``,
      `To keep working, ask to renew from the grant below. ${due.clientName}'s owner must approve the renewal, and each of your people again; until then your current access runs to its end date.`,
      ``,
      `The grant (sign in first):`,
      `  ${grantUrl(due.grantId)}`,
    ].join("\n"),
  };
}

/**
 * One sample reminder, both sides' wording, to a mail provider's test address
 * — for proving delivery from a deployed service without a real grant or a
 * real person. Only Resend's own test domain is accepted, so this can never
 * mail anybody.
 */
export const TEST_RECIPIENT = /^[a-z0-9._+-]+@resend\.dev$/;

export async function sendTestReminder(
  to: string,
  send: ReminderDeps["send"] = sendExpiryReminder,
): Promise<{ sent: number; failed: number; errors: string[] }> {
  if (!TEST_RECIPIENT.test(to)) throw new Error("Test reminders go only to @resend.dev test addresses.");
  const sample: DueReminder = {
    grantId: "00000000-0000-4000-8000-000000000000",
    clientId: "",
    clientName: "Test business",
    agencyId: "",
    agencyName: "Test agency",
    role: "editor",
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    recipients: [],
  };
  const out = { sent: 0, failed: 0, errors: [] as string[] };
  for (const side of ["client", "agency"] as const) {
    const email = reminderEmail(sample, side);
    try {
      await send({ to, subject: `[Test] ${email.subject}`, text: email.text });
      out.sent++;
    } catch (cause) {
      out.failed++;
      out.errors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return out;
}

export type ReminderRun = { due: number; sent: number; failed: number; skipped: number; errors: string[] };

export type ReminderDeps = {
  due: () => Promise<DueReminder[]>;
  claim: (grantId: string, userId: string) => Promise<string | null>;
  record: typeof recordReminder;
  send: (input: { to: string } & ReminderEmail) => Promise<void>;
};

const defaultDeps: ReminderDeps = {
  due: dueExpiryReminders,
  claim: claimReminder,
  record: recordReminder,
  send: sendExpiryReminder,
};

export async function runExpiryReminders(deps: ReminderDeps = defaultDeps): Promise<ReminderRun> {
  const run: ReminderRun = { due: 0, sent: 0, failed: 0, skipped: 0, errors: [] };
  for (const due of await deps.due()) {
    run.due++;
    for (const recipient of due.recipients) {
      const claim = await deps.claim(due.grantId, recipient.userId);
      if (!claim) {
        run.skipped++;
        continue;
      }
      try {
        await deps.send({ to: recipient.email, ...reminderEmail(due, recipient.side) });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        await deps.record(claim, { sent: false, error });
        run.failed++;
        // The grant and the reason, never the address.
        run.errors.push(`${due.grantId}: ${error}`);
        continue;
      }
      await deps.record(claim, {
        sent: true,
        organizationId: recipient.side === "client" ? due.clientId : due.agencyId,
        grantId: due.grantId,
        userId: recipient.userId,
      });
      run.sent++;
    }
  }
  return run;
}
