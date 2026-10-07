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
    `You can choose a password, ask for an emailed code, or continue with Google`,
    `or Microsoft if this address is your work account. You will be asked to`,
    `confirm the address and to set up an authenticator app, which 10XiD asks`,
    `for every time you sign in.`,
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
