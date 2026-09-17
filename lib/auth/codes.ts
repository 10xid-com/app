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
  // Service accounts are not people and have no inbox — their addresses are on
  // a domain reserved never to resolve. Nothing is sent to them, and the
  // verification step refuses them outright as well, so a key's identity can
  // never become a way to sign in.
  if (user && !user.isService) {
    await sendSignInCode({ to: email, code, expiresInMinutes: 10 });
  }

  return "sent";
}

export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "too_many_attempts" };

/**
 * Verify a code.
 *
 * Wrong code, expired code, no code, unknown address and already-used code all
 * return the same "invalid" — a caller learns only that it did not work.
 *
 * The comparison is timing-safe. The code is then consumed by an atomic update
 * whose WHERE clause requires it to still be unconsumed, so two simultaneous
 * submissions produce exactly one winner rather than both succeeding.
 */
export async function verifySignInCode(
  emailRaw: string,
  codeRaw: string,
): Promise<VerifyResult> {
  const email = emailRaw.trim().toLowerCase();
  const code = codeRaw.trim();

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

  const user = await findUserByEmail(email);
  if (!user) {
    // The code was valid but no account exists — possible only if the account
    // was removed between request and verification. Nothing is created here:
    // accounts come from invitations, never from the sign-in form.
    return { ok: false, reason: "invalid" };
  }

  // A service account is the identity an API key acts as. It must never become
  // a session: a key is deliberately write-only and cannot read a client's
  // jobs, and signing in as the account behind it would hand over exactly the
  // read access the key was designed not to have.
  if (user.isService) return { ok: false, reason: "invalid" };

  if (!user.emailVerifiedAt) await markEmailVerified(user.id);

  return { ok: true, userId: user.id };
}
