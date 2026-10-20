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
  userById,
} from "@/lib/db/identity";
import { acceptInvitation, liveInvitationFor } from "@/lib/db/invitations";
import { sixDigitCode } from "@/lib/ids";
import { sendSignInCode } from "./mailer";
import { AUTHENTICATOR_ATTEMPTS, SIGN_IN_CODE } from "./policy";
import { looksLikeRecoveryCode, redeemRecoveryCode } from "./recovery";
import { readSecret, verifyCode } from "./totp";

/**
 * Signing in on the portal itself: a six-digit code emailed to the address on
 * file, and then — every time, for everybody — the authenticator app
 * (./totp.ts) or one of the person's recovery codes (./recovery.ts).
 *
 * The emailed code is the first step and never the whole of it: a session made
 * by it alone is "pending" (./session.ts) and opens nothing but the
 * authenticator screens.
 *
 * Accounts are created by invitation, never by entering an address at the
 * sign-in form. A code is only ever sent to an address that already has an
 * account or a live invitation — but the response is identical either way, so
 * the form cannot be used to discover who has one.
 */

function hashCode(email: string, code: string): Buffer {
  // The address is mixed in so a stolen row cannot be replayed against a
  // different account that happened to be issued the same six digits.
  return createHash("sha256").update(`${email.toLowerCase()}:${code}`, "utf8").digest();
}

export type RequestOutcome = "sent" | "rate_limited";

/**
 * Is there an account, or a live invitation, behind this address?
 *
 * Used only to decide whether a code is worth sending. The ANSWER IS NEVER
 * RETURNED TO THE CALLER — every outcome is "sent" — because a form that
 * distinguished them would be a way to enumerate both who has an account and
 * who has been invited.
 */
async function worthSendingTo(email: string): Promise<boolean> {
  const user = await findUserByEmail(email);
  // A service account has no inbox and is refused at verification anyway.
  if (user) return !user.isService;
  return (await liveInvitationFor(email)) !== null;
}

/**
 * Always reports the same thing whether or not the address is known. The only
 * distinguishable outcome is rate limiting, which applies to addresses that do
 * not exist as well, so it leaks nothing either.
 */
export async function requestSignInCode(emailRaw: string, requestedIp: string | null): Promise<RequestOutcome> {
  const email = emailRaw.trim().toLowerCase();

  const recent = await recentCodeRequests(email, SIGN_IN_CODE.requestWindowSeconds);
  if (recent >= SIGN_IN_CODE.maxRequestsPerWindow) return "rate_limited";

  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + SIGN_IN_CODE.ttlSeconds * 1000);

  // The row is written regardless, so that the rate limit applies to unknown
  // addresses too — otherwise the limit itself would reveal which addresses
  // exist, by only ever triggering for real ones.
  await storeSignInCode({ email, codeHash: hashCode(email, code), expiresAt, requestedIp });

  if (await worthSendingTo(email)) {
    await sendSignInCode({ to: email, code, expiresInMinutes: SIGN_IN_CODE.ttlSeconds / 60 });
  }

  return "sent";
}

export type EmailCodeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "too_many_attempts" };

/**
 * The first step: the emailed code.
 *
 * Wrong code, expired code, no code, unknown address and already-used code all
 * return the same "invalid" — a caller learns only that it did not work.
 *
 * Success says who the person is and nothing more. The session it produces is
 * pending until the authenticator step (verifyAuthenticator below).
 */
export async function verifyEmailCode(emailRaw: string, codeRaw: string): Promise<EmailCodeResult> {
  const email = emailRaw.trim().toLowerCase();
  const code = codeRaw.trim();

  // Service accounts are the identity an API key acts as and must never hold a
  // session: a key is deliberately write-only, and signing in as the account
  // behind it would hand over exactly the read access it was built not to have.
  const account = await findUserByEmail(email);
  if (account?.isService) return { ok: false, reason: "invalid" };

  const row = await latestLiveCode(email);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.attempts >= SIGN_IN_CODE.maxAttempts) return { ok: false, reason: "too_many_attempts" };

  const expected = Buffer.from(row.codeHash);
  const supplied = hashCode(email, code);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    await countCodeAttempt(row.id);
    return { ok: false, reason: "invalid" };
  }

  if (!(await consumeSignInCode(row.id))) return { ok: false, reason: "invalid" };

  // Re-read rather than reusing `account`: the code was valid, and this is the
  // last moment before a session exists, so an account removed in between
  // must not still get one.
  let user = await findUserByEmail(email);

  /**
   * Signing up: the code proved they hold the address, and an invitation says
   * which business that address belongs to. The account is created HERE and
   * not a moment earlier — an invitation on its own is not an account, so
   * withdrawing one before it is used leaves nothing behind. It still has no
   * authority until the person has set up an authenticator.
   *
   * The business comes off the invitation, never from anything typed into the
   * form. The person chooses their address; they do not choose their business.
   */
  if (!user) {
    const invitation = await liveInvitationFor(email);
    if (!invitation) return { ok: false, reason: "invalid" };
    const created = await acceptInvitation({
      invitationId: invitation.id,
      organizationId: invitation.organizationId,
      email,
      role: invitation.role,
    });
    // Lost the race to another sign-up with the same address. One winner.
    if (!created) return { ok: false, reason: "invalid" };
    user = await findUserByEmail(email);
  }

  if (!user || user.isService) return { ok: false, reason: "invalid" };
  if (!user.emailVerifiedAt) await markEmailVerified(user.id);
  return { ok: true, userId: user.id };
}

export type AuthenticatorResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "too_many_attempts" | "not_enrolled" };

/**
 * Wrong authenticator guesses are counted per account in the sign-in code
 * ledger, under a key that can never be an address (it has no "@"), so the
 * limit holds across sessions, browsers and instances without a table of its
 * own. Six digits with a 90-second window, ten tries per quarter hour: a
 * guesser's odds are negligible.
 */
function attemptKey(userId: string): string {
  return `authenticator:${userId}`;
}

async function countWrongGuess(userId: string): Promise<void> {
  await storeSignInCode({
    email: attemptKey(userId),
    // Nothing is ever compared against this; the row only counts.
    codeHash: Buffer.alloc(32),
    expiresAt: new Date(),
    requestedIp: null,
  });
}

/**
 * The second step, every sign-in: a code from the authenticator app, or a
 * recovery code (spent in the process, so the same one never works twice).
 *
 * Also the "confirm it is you" step for actions that need a recent
 * authenticator (lib/auth/policy.ts FRESHNESS_SECONDS).
 */
export async function verifyAuthenticator(userId: string, submitted: string): Promise<AuthenticatorResult> {
  const user = await userById(userId);
  if (!user || user.isService) return { ok: false, reason: "invalid" };
  if (!user.totpSecret || !user.totpConfirmedAt) return { ok: false, reason: "not_enrolled" };

  const wrong = await recentCodeRequests(attemptKey(userId), AUTHENTICATOR_ATTEMPTS.windowSeconds);
  if (wrong >= AUTHENTICATOR_ATTEMPTS.max) return { ok: false, reason: "too_many_attempts" };

  const secret = readSecret(user.totpSecret);
  if (secret && verifyCode(secret, submitted)) return { ok: true };
  if (looksLikeRecoveryCode(submitted) && (await redeemRecoveryCode(user.id, submitted))) return { ok: true };

  await countWrongGuess(userId);
  return { ok: false, reason: "invalid" };
}

/**
 * The first code typed during enrolment, against the secret just issued.
 * Counted against the same limit as a sign-in.
 */
export async function verifyEnrolmentCode(userId: string, submitted: string): Promise<AuthenticatorResult> {
  const user = await userById(userId);
  if (!user || user.isService || !user.totpSecret) return { ok: false, reason: "not_enrolled" };

  const wrong = await recentCodeRequests(attemptKey(userId), AUTHENTICATOR_ATTEMPTS.windowSeconds);
  if (wrong >= AUTHENTICATOR_ATTEMPTS.max) return { ok: false, reason: "too_many_attempts" };

  const secret = readSecret(user.totpSecret);
  if (secret && verifyCode(secret, submitted)) return { ok: true };
  await countWrongGuess(userId);
  return { ok: false, reason: "invalid" };
}
