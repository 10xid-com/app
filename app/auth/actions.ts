"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  requirePendingSignInAction,
  requireSameOriginRequest,
  requireSignedInAction,
  stepUpPath,
} from "@/lib/auth/authorize";
import {
  requestSignInCode,
  verifyAuthenticator,
  verifyEmailCode,
  verifyEnrolmentCode,
} from "@/lib/auth/codes";
import { clearPassword, passwordProblem, setPassword, verifyPasswordSignIn } from "@/lib/auth/password";
import { safePath } from "@/lib/auth/paths";
import { FRESHNESS_SECONDS } from "@/lib/auth/policy";
import { RECOVERY_FLASH_COOKIE, issueRecoveryCodes } from "@/lib/auth/recovery";
import {
  completeSignIn,
  refreshSecondFactor,
  resolveIdentity,
  startPendingSession,
  writeSessionCookie,
} from "@/lib/auth/session";
import { encryptSecret, generateSecret } from "@/lib/auth/totp";
import { confirmTotp, revokeSession, setTotpSecret, userById } from "@/lib/db/identity";

/**
 * Signing in on the portal: the address, the emailed code, then the
 * authenticator (or setting one up). See lib/auth/codes.ts for the rules and
 * lib/auth/session.ts for what a pending session can reach.
 */

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const sixDigits = z.string().trim().regex(/^\d{6}$/);
/** Six digits, or a recovery code (A1B2-C3D4, hyphen optional). */
const authenticatorSchema = z.string().trim().regex(/^(\d{6}|[0-9A-Za-z]{4}[-\s]?[0-9A-Za-z]{4})$/);

/**
 * The client's address, as the platform's proxy reports it. The header is the
 * same one the login host trusts (CLIENT_IP_HEADER, x-real-ip by default); a
 * value the caller could choose only weakens a log line, never a limit, since
 * the limits are per address and per account.
 */
async function clientIp(): Promise<string | null> {
  const name = (process.env.CLIENT_IP_HEADER || "x-real-ip").toLowerCase();
  return (await headers()).get(name)?.trim().slice(0, 64) || null;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** Step one: the address. A code goes to it if it has an account or an invitation. */
export async function requestCodeAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  const next = safePath(formData.get("next"));
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) redirect(`/auth/sign-in?${q({ error: "email", next })}`);

  const outcome = await requestSignInCode(parsed.data, await clientIp());
  if (outcome === "rate_limited") {
    redirect(`/auth/sign-in?${q({ error: "rate", next, email: parsed.data })}`);
  }
  redirect(`/auth/verify?${q({ email: parsed.data, next })}`);
}

/**
 * Step one and two together, for somebody who has set a password: the
 * address and the password instead of the emailed code. The same pending
 * session follows, and the same authenticator step.
 */
export async function passwordSignInAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  const next = safePath(formData.get("next"));
  const email = emailSchema.safeParse(formData.get("email"));
  const password = String(formData.get("password") ?? "");
  const back = (error: string) =>
    `/auth/sign-in?${q({ method: "password", email: String(formData.get("email") ?? ""), next, error })}`;
  if (!email.success || !password) redirect(back("password"));

  const result = await verifyPasswordSignIn(email.data, password);
  if (!result.ok) redirect(back(result.reason === "too_many_attempts" ? "password_rate" : "password"));

  const before = await resolveIdentity();
  if (before.state !== "signed_out") await revokeSession(before.sessionId);

  const { token, expiresAt } = await startPendingSession(result.userId);
  await writeSessionCookie(token, expiresAt);
  redirect(`/auth/authenticator?${q({ next })}`);
}

/** Step two: the emailed code. Success is a pending session, for the authenticator screens only. */
export async function verifyCodeAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  const next = safePath(formData.get("next"));
  const email = emailSchema.safeParse(formData.get("email"));
  const code = sixDigits.safeParse(formData.get("code"));
  const back = (error: string) =>
    `/auth/verify?${q({ email: String(formData.get("email") ?? ""), next, error })}`;
  if (!email.success || !code.success) redirect(back("invalid"));

  const result = await verifyEmailCode(email.data, code.data);
  if (!result.ok) redirect(back(result.reason));

  // Whatever this browser held before — another person's pending sign-in,
  // or an old session — ends here rather than lingering beside the new one.
  const before = await resolveIdentity();
  if (before.state !== "signed_out") await revokeSession(before.sessionId);

  const { token, expiresAt } = await startPendingSession(result.userId);
  await writeSessionCookie(token, expiresAt);
  redirect(`/auth/authenticator?${q({ next })}`);
}

/** Step three, for somebody with an authenticator: its code, or a recovery code. */
export async function authenticatorAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  const pending = await requirePendingSignInAction(formData, next);
  const back = (error: string) => `/auth/authenticator?${q({ next, error })}`;

  const code = authenticatorSchema.safeParse(formData.get("code"));
  if (!code.success) redirect(back("invalid"));

  const result = await verifyAuthenticator(pending.userId, code.data);
  if (!result.ok) redirect(back(result.reason));

  const { token, expiresAt } = await completeSignIn(pending.sessionId, pending.userId);
  await writeSessionCookie(token, expiresAt);
  redirect(next);
}

/**
 * Setting up an authenticator: a fresh secret every time this is pressed,
 * replacing any that was issued and never confirmed.
 *
 * Only while the account has no CONFIRMED authenticator. Otherwise anyone
 * holding the inbox could replace the second factor with their own, which
 * would make it decorative — resetting a confirmed one is an operator's job
 * (README, "Lost authenticator"), not a button.
 */
export async function beginEnrolmentAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  const pending = await requirePendingSignInAction(formData, next);
  if (pending.enrolled) redirect(`/auth/authenticator?${q({ next })}`);
  await setTotpSecret(pending.userId, encryptSecret(generateSecret()));
  redirect(`/auth/authenticator?${q({ next, step: "scan" })}`);
}

/**
 * The first code from the new authenticator: it confirms the setup and
 * finishes signing in, and recovery codes are issued and shown at once.
 */
export async function confirmEnrolmentAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  const pending = await requirePendingSignInAction(formData, next);
  if (pending.enrolled) redirect(`/auth/authenticator?${q({ next })}`);
  const back = (error: string) => `/auth/authenticator?${q({ next, step: "scan", error })}`;

  const code = sixDigits.safeParse(formData.get("code"));
  if (!code.success) redirect(back("invalid"));

  const result = await verifyEnrolmentCode(pending.userId, code.data);
  if (!result.ok) redirect(back(result.reason));

  await confirmTotp(pending.userId);
  const { token, expiresAt } = await completeSignIn(pending.sessionId, pending.userId);
  await writeSessionCookie(token, expiresAt);
  await stashCodesForOneViewing(await issueRecoveryCodes(pending.userId));
  redirect(`/auth/recovery-codes?${q({ next })}`);
}

/**
 * Hand freshly issued recovery codes to the screen that shows them. Only
 * hashes are stored, so this short-lived, script-unreadable cookie, on the
 * person's own browser, is the one hop they exist in readable form; it is
 * cleared when they acknowledge the screen and lapses in five minutes anyway.
 */
async function stashCodesForOneViewing(codes: string[]) {
  (await cookies()).set(RECOVERY_FLASH_COOKIE, codes.join(" "), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE !== "false",
    path: "/auth",
    maxAge: 300,
  });
}

/** Acknowledged and written down: drop the carrier and get on with it. */
export async function acknowledgeRecoveryCodesAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  await requireSignedInAction(formData, next);
  (await cookies()).set(RECOVERY_FLASH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE !== "false",
    path: "/auth",
    maxAge: 0,
  });
  redirect(next);
}

/**
 * A fresh set of recovery codes, retiring whatever is left. They are the way
 * past the authenticator, so this needs it within the last five minutes.
 */
export async function regenerateRecoveryCodesAction(formData: FormData) {
  const ctx = await requireSignedInAction(formData, "/auth/security");
  if (Date.now() - ctx.secondFactorAt.getTime() > FRESHNESS_SECONDS.decision * 1000) {
    redirect(stepUpPath("/auth/security"));
  }
  const user = await userById(ctx.userId);
  if (!user?.totpConfirmedAt) redirect("/auth/security");
  await stashCodesForOneViewing(await issueRecoveryCodes(ctx.userId));
  redirect(`/auth/recovery-codes?${q({ next: "/auth/security" })}`);
}

/**
 * Set or change the portal password. It opens the first step of a sign-in
 * on its own, so it needs the authenticator within the last five minutes.
 */
export async function setPasswordAction(formData: FormData) {
  const ctx = await requireSignedInAction(formData, "/auth/security");
  if (Date.now() - ctx.secondFactorAt.getTime() > FRESHNESS_SECONDS.decision * 1000) {
    redirect(stepUpPath("/auth/security"));
  }
  const password = String(formData.get("password") ?? "");
  const problem = passwordProblem(password, String(formData.get("confirm") ?? ""));
  if (problem) redirect(`/auth/security?${q({ error: `password_${problem}` })}`);
  await setPassword(ctx.userId, password);
  redirect("/auth/security?done=password");
}

/** Remove the password: signing in goes back to the emailed code only. */
export async function removePasswordAction(formData: FormData) {
  const ctx = await requireSignedInAction(formData, "/auth/security");
  await clearPassword(ctx.userId);
  redirect("/auth/security?done=password_removed");
}

/** "Confirm it is you": the authenticator again, for actions that need it recent. */
export async function confirmAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  const ctx = await requireSignedInAction(formData, next);
  const code = authenticatorSchema.safeParse(formData.get("code"));
  if (!code.success) redirect(`/auth/confirm?${q({ next, error: "invalid" })}`);

  const result = await verifyAuthenticator(ctx.userId, code.data);
  if (!result.ok) redirect(`/auth/confirm?${q({ next, error: result.reason })}`);

  await refreshSecondFactor(ctx.sessionId);
  redirect(next);
}
