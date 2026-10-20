import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { findUserByEmail, recentCodeRequests, setPasswordHash, storeSignInCode } from "@/lib/db/identity";
import { PASSWORD } from "./policy";

/**
 * The portal's own password (users.password_hash, login's 0053).
 *
 * A password is an alternative FIRST step to the emailed code
 * (lib/auth/codes.ts), never a way past the authenticator: what it produces
 * is the same pending session, and only an account that already has a
 * confirmed authenticator can sign in with one. It is set by the person on
 * /auth/security, with the authenticator typed in the last five minutes.
 *
 * Stored as scrypt with a random salt and its parameters, so they can be
 * raised later without guessing what an old row used:
 * `scrypt$N$r$p$salt$hash`, base64url.
 */

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
// scrypt needs 128 * N * r bytes; Node's default ceiling is exactly that, so give it room.
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function passwordMatches(stored: string | null, password: string): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    // Still spend the time, so an account with no password answers as slowly
    // as one with a wrong password.
    await derive(password, randomBytes(16), N, R, P);
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** What a new password must be. Null when it is acceptable. */
export function passwordProblem(password: string, confirm: string): "short" | "long" | "mismatch" | null {
  if (password.length < PASSWORD.minLength) return "short";
  if (password.length > PASSWORD.maxLength) return "long";
  if (password !== confirm) return "mismatch";
  return null;
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await setPasswordHash(userId, await hashPassword(password));
}

export async function clearPassword(userId: string): Promise<void> {
  await setPasswordHash(userId, null);
}

/**
 * Wrong guesses are counted per address in the sign-in code ledger, under a
 * key that can never be an address (a hash, no "@"), for known and unknown
 * addresses alike, so the limit itself reveals nothing.
 */
function attemptKey(email: string): string {
  return `password:${createHash("sha256").update(email, "utf8").digest("hex")}`;
}

export type PasswordResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "too_many_attempts" };

/**
 * The password as the first step. Unknown address, no password, wrong
 * password, a service account, and an account with no authenticator yet are
 * all the same "invalid": the form learns only that it did not work. (Setting
 * up the authenticator always starts from the emailed code.)
 */
export async function verifyPasswordSignIn(emailRaw: string, password: string): Promise<PasswordResult> {
  const email = emailRaw.trim().toLowerCase();
  const key = attemptKey(email);
  if ((await recentCodeRequests(key, PASSWORD.windowSeconds)) >= PASSWORD.maxAttempts) {
    return { ok: false, reason: "too_many_attempts" };
  }

  const user = await findUserByEmail(email);
  const usable = user && !user.isService && user.totpSecret && user.totpConfirmedAt ? user : null;
  const matches = await passwordMatches(usable?.passwordHash ?? null, password);
  if (usable && matches) return { ok: true, userId: usable.id };

  await storeSignInCode({ email: key, codeHash: Buffer.alloc(32), expiresAt: new Date(), requestedIp: null });
  return { ok: false, reason: "invalid" };
}
