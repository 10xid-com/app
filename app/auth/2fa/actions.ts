"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  confirmTotp,
  markSecondFactorPassed,
  setTotpSecret,
  userById,
} from "@/lib/db/identity";
import { getSessionContext } from "@/lib/auth/session";
import { safePath } from "@/lib/auth/sso";
import {
  decryptSecret,
  encryptSecret,
  generateSecret,
  verifyCode,
} from "@/lib/auth/totp";

const codeSchema = z.string().trim().regex(/^\d{6}$/);

/**
 * Enrol, or verify. One action, because from the person's side it is one
 * screen: they either have an authenticator set up or they are setting one up.
 */
export async function verifySecondFactorAction(formData: FormData) {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");

  // Only staff carry a second factor. A client reaching this form has nothing
  // to do here.
  if (ctx.role !== "staff") redirect("/jobs");

  const next = safePath(formData.get("next"));
  const back = (err: string) =>
    `/auth/2fa?next=${encodeURIComponent(next)}&error=${err}`;

  const parsed = codeSchema.safeParse(formData.get("code"));
  if (!parsed.success) redirect(back("format"));

  const user = await userById(ctx.userId);
  if (!user?.totpSecret) redirect(back("notset"));

  const secret = decryptSecret(user.totpSecret);
  if (!verifyCode(secret, parsed.data)) {
    redirect(back("wrong"));
  }

  // The first accepted code confirms the enrolment as well as the session.
  if (!user.totpConfirmedAt) await confirmTotp(user.id);
  await markSecondFactorPassed(ctx.sessionId);

  // Land where they were originally heading, not on a fixed page.
  redirect(next);
}

/**
 * Issue a fresh secret.
 *
 * Only possible while the account has no CONFIRMED secret. Otherwise anyone who
 * reached a half-authenticated session could replace the second factor with
 * their own, which would make it decorative — resetting a confirmed one is
 * deliberately an out-of-band task, not a button on this page.
 */
export async function beginEnrolmentAction(formData: FormData) {
  const next = safePath(formData.get("next"));
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");
  if (ctx.role !== "staff") redirect("/jobs");

  const user = await userById(ctx.userId);
  if (user?.totpConfirmedAt) redirect("/auth/2fa?error=already");

  await setTotpSecret(ctx.userId, encryptSecret(generateSecret()));
  redirect(`/auth/2fa?next=${encodeURIComponent(next)}`);
}
