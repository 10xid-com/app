import "server-only";
import { appendFile } from "node:fs/promises";

/**
 * Delivery of sign-in codes.
 *
 * In production this goes through Resend. With no API key configured — local
 * development and tests — the code is written to the server log and to a file,
 * so the flow can be exercised end to end without sending real email to real
 * people.
 *
 * The development sink is deliberately a file outside the repository rather
 * than an endpoint the application serves. An endpoint that hands out sign-in
 * codes is a backdoor if it ever survives into production, and "it is only
 * enabled in development" is exactly the sentence that precedes an incident.
 */

const DEV_CODE_SINK =
  process.env.DEV_CODE_SINK ?? "/tmp/portal-signin-codes.log";

export async function sendSignInCode(input: {
  to: string;
  code: string;
  expiresInMinutes: number;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY is not set, so sign-in codes cannot be delivered. " +
          "Refusing to fall back to writing codes to disk in production.",
      );
    }
    const line = `${new Date().toISOString()}\t${input.to}\t${input.code}\n`;
    await appendFile(DEV_CODE_SINK, line, "utf8");
    console.log(`[dev] sign-in code for ${input.to}: ${input.code}`);
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    subject: `${input.code} is your sign-in code`,
    text: [
      `Your sign-in code is ${input.code}.`,
      ``,
      `It expires in ${input.expiresInMinutes} minutes and can be used once.`,
      ``,
      `If you did not ask to sign in, you can ignore this message — the code`,
      `is useless without access to this mailbox.`,
    ].join("\n"),
  });
}

/**
 * Tell somebody they have been invited.
 *
 * Carries no credential. The invitation lives in the database against this
 * address, and the first sign-in on the login host with this address VERIFIED,
 * past the authenticator, is what
 * accepts it — so this message being forwarded, quoted or leaked hands nobody
 * an account. Somebody signing in with a different address, even at the same
 * company, matches nothing.
 */
export async function sendInvitation(input: {
  to: string;
  organizationName: string;
  invitedByEmail: string;
  signUpUrl: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  const body = [
    `${input.invitedByEmail} has invited you to the 10XiD portal for ${input.organizationName}.`,
    ``,
    `To accept, create your sign-in with this exact address at:`,
    `  ${input.signUpUrl}`,
    ``,
    `We will email it a code (or continue with Google or Microsoft if it is your`,
    `work account). You will then set up an authenticator app, which 10XiD asks`,
    `for every time you sign in, and can add a password afterwards.`,
    `The invitation works once and lapses after 7 days.`,
    ``,
    `If you were not expecting this, you can ignore it. The invitation grants`,
    `nothing on its own.`,
  ].join("\n");

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY is not set, so invitations cannot be delivered. " +
          "Refusing to fall back to writing them to disk in production.",
      );
    }
    await appendFile(
      DEV_CODE_SINK,
      `${new Date().toISOString()}\t${input.to}\tINVITED\t${input.organizationName}\n`,
      "utf8",
    );
    console.log(`[dev] invitation for ${input.to} → ${input.organizationName}`);
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    subject: `You have been invited to the 10XiD portal`,
    text: body,
  });
}

/**
 * Tell a business's owners that agency access is waiting for their decision.
 *
 * Carries no credential and no link that acts: the decision is made on the
 * Team page, signed in, with a fresh authenticator code.
 */
export async function sendAgencyNotice(input: {
  to: string[];
  businessName: string;
  agencyName: string;
  what: string;
  teamUrl: string;
}): Promise<void> {
  if (input.to.length === 0) return;
  const apiKey = process.env.RESEND_API_KEY;
  const subject = `${input.agencyName} is asking for access to ${input.businessName}`;
  const body = [
    `${input.agencyName} ${input.what} for ${input.businessName} on 10XiD.`,
    ``,
    `Nothing changes until an owner of ${input.businessName} decides. To review it, sign in and open:`,
    `  ${input.teamUrl}`,
    ``,
    `If you were not expecting this, decline it there.`,
  ].join("\n");

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is not set, so agency notices cannot be delivered.");
    }
    await appendFile(
      DEV_CODE_SINK,
      input.to.map((to) => `${new Date().toISOString()}\t${to}\tAGENCY\t${input.agencyName} → ${input.businessName}\n`).join(""),
      "utf8",
    );
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    subject,
    text: body,
  });
}

/**
 * An agency-grant expiry reminder (lib/agency/reminders.ts). Unlike the
 * notices above, a delivery failure is an error the caller sees: the
 * reminder run records it and tries again, so it must not pass silently.
 */
export async function sendExpiryReminder(input: { to: string; subject: string; text: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is not set, so expiry reminders cannot be delivered.");
    }
    await appendFile(DEV_CODE_SINK, `${new Date().toISOString()}\t${input.to}\tREMINDER\t${input.subject}\n`, "utf8");
    return;
  }
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  if (error) throw new Error(`Resend refused the reminder: ${error.message}`);
}

/**
 * Tell somebody a job has been handed to them.
 *
 * Carries no credential: the button opens the job, signed in, like any other
 * page. The note is what a teammate typed: escaped in the HTML, and sent as
 * it was in the text. A failure is the caller's to swallow: the handover
 * stands without it, and the job is under "Assigned to me" either way.
 */
export type HandoverNotice = {
  to: string;
  fromName: string;
  businessName: string;
  jobRef: string;
  jobTitle: string;
  note: string | null;
  jobUrl: string;
};

/** The message, as text and as HTML. Pure, so it can be tested without sending. */
export function handoverMessage(input: HandoverNotice): { subject: string; text: string; html: string } {
  return {
    subject: `${input.fromName} handed you ${input.jobRef}: ${input.jobTitle}`,
    text: [
      `${input.fromName} handed you a job at ${input.businessName} on 10XiD.`,
      ``,
      `  ${input.jobRef}  ${input.jobTitle}`,
      ...(input.note ? [``, `Their note:`, ...input.note.split("\n").map((line) => `  ${line}`)] : []),
      ``,
      `Open the job: ${input.jobUrl}`,
      ``,
      HANDOVER_FOOTER,
    ].join("\n"),
    html: handoverHtml(input),
  };
}

const HANDOVER_FOOTER =
  "You will be asked to sign in if you are not already. It is under \u201cAssigned to me\u201d on your Jobs page too.";

const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The same message as HTML, in the sign-in code emails' card (login's
 * lib/auth/mailer.ts): the job in a box, the note quoted, a button to the job.
 * Plain inline styles only.
 */
function handoverHtml(input: HandoverNotice): string {
  const note = input.note
    ? `
      <tr><td style="padding:0 28px 4px;font-size:12px;font-weight:600;color:#5b625e">${escapeHtml(input.fromName)}\u2019s note</td></tr>
      <tr><td style="padding:0 28px 8px">
        <div style="border-left:3px solid #244a80;background:#f5f6f4;border-radius:0 8px 8px 0;padding:10px 14px;font-size:14px;line-height:1.5;color:#1c1f1d">${escapeHtml(input.note).replace(/\r?\n/g, "<br>")}</div>
      </td></tr>`
    : "";
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1f1d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e3e6e1;border-radius:16px">
      <tr><td style="padding:28px 28px 8px;font-size:12px;font-weight:600;letter-spacing:.06em;color:#244a80">10XiD</td></tr>
      <tr><td style="padding:0 28px;font-size:15px;line-height:1.5"><strong>${escapeHtml(input.fromName)}</strong> handed you a job at ${escapeHtml(input.businessName)}.</td></tr>
      <tr><td style="padding:16px 28px">
        <div style="border:1px solid #e3e6e1;border-radius:10px;padding:12px 14px">
          <div style="font-size:12px;letter-spacing:.06em;color:#5b625e;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(input.jobRef)}</div>
          <div style="padding-top:2px;font-size:17px;font-weight:700;line-height:1.35">${escapeHtml(input.jobTitle)}</div>
        </div>
      </td></tr>${note}
      <tr><td style="padding:12px 28px 16px">
        <a href="${escapeHtml(input.jobUrl)}" style="display:inline-block;background:#244a80;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:8px">Open the job</a>
      </td></tr>
      <tr><td style="padding:0 28px 28px;font-size:13px;line-height:1.5;color:#5b625e">${escapeHtml(HANDOVER_FOOTER)}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export async function sendHandoverNotice(input: HandoverNotice): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const message = handoverMessage(input);

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is not set, so handover notices cannot be delivered.");
    }
    await appendFile(DEV_CODE_SINK, `${new Date().toISOString()}\t${input.to}\tHANDOVER\t${message.subject}\n`, "utf8");
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: process.env.MAIL_FROM ?? "10XiD <no-reply@10xid.com>",
    to: input.to,
    ...message,
  });
  if (error) throw new Error(`Resend refused the handover notice: ${error.message}`);
}
