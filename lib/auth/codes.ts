import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  consumeSignInCode,
  countCodeAttempt,
  findUserByEmail,
  latestLiveCode,
  markEmailVerified,
  recentCodeRequests,
  storeSignInCode,
} from "@/lib/db/identity";
import { sixDigitCode } from "@/lib/ids";
import { sendSignInCode } from "./mailer";
import { SIGN_IN_CODE } from "./policy";
import { looksLikeRecoveryCode, redeemRecoveryCode } from "./recovery";
import { decryptSecret, verifyCode } from "./totp";

/**
 * Sign-in by a six-digit code sent to the address on file.
 *
 * There is no password column anywhere in this system. Clients sign in a
 * handful of times a year; a password they will forget recreates exactly the
 * "can you let me back in" support burden the portal exists to remove, and a
 * password database is a liability with no upside here.
 *
 * Accounts are created by invitation, never by entering an address at the
 * sign-in form. A code is only ever sent to an address that already has an
 * account — but the response is identical either way, so the form cannot be
 * used to discover who has one.
 */

function hashCode(email: string, code: string): Buffer {
  // The address is mixed in so a stolen row cannot be replayed against a
  // different account that happened to be issued the same six digits.
  return createHash("sha256")
    .update(`${email.toLowerCase()}:${code}`, "utf8")
    .digest();
}

export type RequestOutcome = "sent" | "rate_limited";

/**
 * Always reports the same thing to the caller whether or not the address is
 * known. The only distinguishable outcome is rate limiting, which applies to
 * addresses that do not exist as well, so it leaks nothing either.
 */
export async function requestSignInCode(
  emailRaw: string,
  requestedIp: string | null,
): Promise<RequestOutcome> {
  const email = emailRaw.trim().toLowerCase();

  const recent = await recentCodeRequests(
    email,
    SIGN_IN_CODE.requestWindowSeconds,
  );
  if (recent >= SIGN_IN_CODE.maxRequestsPerWindow) {
    return "rate_limited";
  }

  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + SIGN_IN_CODE.ttlSeconds * 1000);

  // The row is written regardless, so that the rate limit applies to unknown
  // addresses too — otherwise the limit itself would reveal which addresses
  // exist, by only ever triggering for real ones.
  await storeSignInCode({
    email,
    codeHash: hashCode(email, code),
    expiresAt,
    requestedIp,
  });

  const user = await findUserByEmail(email);

  // Three reasons nothing is sent, and the caller is told the same thing in all
  // of them, because the answer is what would otherwise reveal who has what.
  //
  //  * No account. Sending would confirm the address exists.
  //  * A service account: not a person, no inbox, and refused at verification.
  //  * An account with a confirmed authenticator. Its code comes from the
  //    authenticator now, so an email would be both useless and misleading —
  //    and, more to the point, the emailed code no longer opens that account.
  const usesAuthenticator = Boolean(user?.totpConfirmedAt);
  if (user && !user.isService && !usesAuthenticator) {
    await sendSignInCode({ to: email, code, expiresInMinutes: 10 });
  }

  return "sent";
}

export type VerifyResult =
  | { ok: true; userId: string; secondFactorPassed: boolean }
  | { ok: false; reason: "invalid" | "too_many_attempts" };

/**
 * Sign in with the authenticator, for an account that has one.
 *
 * This REPLACES the emailed code rather than sitting beside it. If both worked,
 * anyone holding the inbox could simply ignore the authenticator and it would
 * be decorative — so for an account with a confirmed authenticator, the emailed
 * code is not accepted at all. `verifySignInCode` below enforces that by
 * routing here and never falling through.
 *
 * A recovery code is accepted here too, because with the emailed code closed
 * off it is the only remaining way back in from a lost phone. It is spent in
 * the process, so the same one never works twice.
 */
async function verifyAuthenticator(
  user: NonNullable<Awaited<ReturnType<typeof findUserByEmail>>>,
  submitted: string,
): Promise<VerifyResult> {
  if (!user.totpSecret) return { ok: false, reason: "invalid" };

  if (verifyCode(decryptSecret(user.totpSecret), submitted)) {
    // The authenticator IS the factor that was checked, so the session it
    // produces has already cleared its second factor. Sending it to the
    // enrolment screen afterwards would be asking for the same code twice.
    return { ok: true, userId: user.id, secondFactorPassed: true };
  }

  if (
    looksLikeRecoveryCode(submitted) &&
    (await redeemRecoveryCode(user.id, submitted))
  ) {
    return { ok: true, userId: user.id, secondFactorPassed: true };
  }

  return { ok: false, reason: "invalid" };
}

/**
 * Verify whatever was typed into the one code box.
 *
 * There is a single screen for this, identical for everybody, and it has to
 * stay that way: a form that behaved differently for an account with an
 * authenticator would be a way to discover which addresses have accounts and
 * which people are staff, just by watching how the page answers.
 *
 * So the branch happens HERE, on the server, after the address is resolved:
 *
 *   * A confirmed authenticator → the code must come from it, or be a recovery
 *     code. The emailed code is not accepted, and there is no fallthrough.
 *   * Otherwise → the emailed code, exactly as before.
 *
 * Wrong code, expired code, no code, unknown address and already-used code all
 * return the same "invalid" — a caller learns only that it did not work.
 */
export async function verifySignInCode(
  emailRaw: string,
  codeRaw: string,
): Promise<VerifyResult> {
  const email = emailRaw.trim().toLowerCase();
  const code = codeRaw.trim();

  const account = await findUserByEmail(email);

  // Service accounts are the identity an API key acts as and must never hold a
  // session: a key is deliberately write-only, and signing in as the account
  // behind it would hand over exactly the read access it was built not to have.
  // Checked before anything else, so no path below can miss it.
  if (account?.isService) return { ok: false, reason: "invalid" };

  if (account?.totpConfirmedAt) {
    return verifyAuthenticator(account, code);
  }

  const row = await latestLiveCode(email);
  if (!row) return { ok: false, reason: "invalid" };

  if (row.attempts >= SIGN_IN_CODE.maxAttempts) {
    return { ok: false, reason: "too_many_attempts" };
  }

  const expected = Buffer.from(row.codeHash);
  const supplied = hashCode(email, code);
  const matches =
    expected.length === supplied.length && timingSafeEqual(expected, supplied);

  if (!matches) {
    await countCodeAttempt(row.id);
    return { ok: false, reason: "invalid" };
  }

  const consumed = await consumeSignInCode(row.id);
  if (!consumed) return { ok: false, reason: "invalid" };

  // Re-read rather than reusing `account` from above: the code was valid, and
  // this is the last moment before a session exists, so an account removed in
  // between must not still get one. Nothing is created here either — accounts
  // come from invitations, never from the sign-in form.
  const user = await findUserByEmail(email);
  if (!user || user.isService) return { ok: false, reason: "invalid" };

  if (!user.emailVerifiedAt) await markEmailVerified(user.id);

  // An emailed code is one factor. Staff without an authenticator are still
  // sent to enrol before their session carries any authority at all.
  return { ok: true, userId: user.id, secondFactorPassed: false };
}
