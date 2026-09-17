import "server-only";
import { createHash, randomInt } from "node:crypto";
import { consumeRecoveryCode, replaceRecoveryCodes } from "@/lib/db/identity";

/**
 * Recovery codes.
 *
 * These exist because of a specific consequence of making the authenticator the
 * way in: once an account holds a confirmed authenticator, the emailed code
 * stops working for it. That is the point — if the emailed code still worked,
 * anyone holding the inbox could ignore the authenticator entirely and it would
 * be decorative. But it also means a lost, wiped or stolen phone is a permanent
 * lockout, on the account that reaches every client.
 *
 * So: ten codes, shown once at enrolment, each usable once.
 */

export const RECOVERY_CODE_COUNT = 10;

/**
 * Carries a freshly issued set from the action that made them to the screen
 * that shows them.
 *
 * They exist in readable form for exactly one hop — only hashes are stored, so
 * the next page cannot render them from the database. A short-lived httpOnly
 * cookie is the least bad carrier: not the URL, which would put ten live
 * credentials into browser history and any referrer header; not the database,
 * which is the one place they are deliberately not recoverable from.
 *
 * Declared here rather than beside the action that sets it, because a
 * "use server" module may only export async functions — a constant exported
 * from one is a compile error, and it is one the type checker does not catch.
 */
export const RECOVERY_FLASH_COOKIE = "portal_recovery_once";

/**
 * Crockford's base32, minus the letters that get misread off a screen: no I, L
 * or O to confuse with 1 and 0, and no U, which is the one that turns an
 * innocent code into a word people will not type into a work laptop.
 *
 * 8 characters from a 29-character alphabet is about 39 bits — far beyond
 * guessing, and short enough to read off paper without losing your place.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".replace(/[ILOU]/g, "");
const LENGTH = 8;

/** Stored as a hash, like every other secret here. */
function hashCode(userId: string, code: string): Buffer {
  // The account id is mixed in so a stolen row cannot be replayed against a
  // different account that happened to be issued the same characters.
  return createHash("sha256")
    .update(`${userId}:${normalise(code)}`, "utf8")
    .digest();
}

/**
 * Accept what a person actually types.
 *
 * The code is displayed as `A1B2-C3D4`, and people retype it with the hyphen,
 * without it, in lower case, or with a space where the hyphen was. All of those
 * are the same code, so they are all folded to one form before hashing rather
 * than being four different wrong answers.
 */
function normalise(code: string): string {
  return code.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
}

function generateOne(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  // Hyphenated in the middle purely so it can be read aloud and copied by eye.
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Issue a fresh set, replacing any that exist.
 *
 * Replacing rather than adding matters: re-enrolling an authenticator must not
 * leave the previous set live, or codes printed out a year ago would still open
 * an account whose second factor has since been replaced.
 *
 * The plaintext is returned exactly once, to be shown and then forgotten. There
 * is no way to read them back, here or anywhere else.
 */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateOne);
  await replaceRecoveryCodes(
    userId,
    codes.map((code) => hashCode(userId, code)),
  );
  return codes;
}

/**
 * Spend a code, or don't.
 *
 * Consumption is a single atomic update whose WHERE clause requires the row to
 * still be unused, so two simultaneous submissions of the same code produce
 * exactly one winner rather than both being let in.
 */
export async function redeemRecoveryCode(
  userId: string,
  submitted: string,
): Promise<boolean> {
  const cleaned = normalise(submitted);
  if (cleaned.length !== LENGTH) return false;
  return consumeRecoveryCode(userId, hashCode(userId, submitted));
}

/** Could this be a recovery code rather than a six-digit one? */
export function looksLikeRecoveryCode(input: string): boolean {
  return normalise(input).length === LENGTH;
}
