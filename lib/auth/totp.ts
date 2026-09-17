import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Staff get this on top of the emailed code because a staff session reaches
 * every client's data. The email code alone means one compromised inbox reaches
 * every client — and an inbox is exactly the thing most likely to be
 * compromised, since it is also where password resets for everything else land.
 *
 * Deliberately small and dependency-free: TOTP is HMAC, a counter and a modulo,
 * and the specification is short enough to implement exactly rather than trust
 * a transitive dependency with.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * How many 30-second steps either side of now are accepted.
 *
 * One step each way covers ordinary clock drift between a phone and the server.
 * Widening it trades security for convenience linearly: every extra step is
 * another valid code at any moment.
 */
const WINDOW_STEPS = 1;

/* ------------------------------------------------------------------ */
/* Base32, because that is what authenticator apps speak              */
/* ------------------------------------------------------------------ */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ------------------------------------------------------------------ */
/* The algorithm                                                       */
/* ------------------------------------------------------------------ */

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  // SHA-1 is specified by RFC 4226 and is not a weakness here: this is an HMAC
  // with a secret key over a counter, not a collision-resistance problem.
  const digest = createHmac("sha1", secret).update(buf).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function generateSecret(): string {
  // 20 bytes is the RFC 4226 recommendation and what authenticator apps expect.
  return base32Encode(randomBytes(20));
}

export function currentCode(secretBase32: string, at = Date.now()): string {
  return hotp(
    base32Decode(secretBase32),
    Math.floor(at / 1000 / STEP_SECONDS),
  );
}

/**
 * Verify a submitted code.
 *
 * Every candidate is compared in constant time, and all candidates are checked
 * rather than returning early on a match, so the time taken does not reveal
 * which step matched or how close a wrong guess was.
 */
export function verifyCode(
  secretBase32: string,
  submitted: string,
  at = Date.now(),
): boolean {
  const clean = submitted.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;

  const secret = base32Decode(secretBase32);
  const step = Math.floor(at / 1000 / STEP_SECONDS);
  const supplied = Buffer.from(clean, "utf8");

  let matched = false;
  for (let i = -WINDOW_STEPS; i <= WINDOW_STEPS; i++) {
    const candidate = Buffer.from(hotp(secret, step + i), "utf8");
    if (
      candidate.length === supplied.length &&
      timingSafeEqual(candidate, supplied)
    ) {
      matched = true;
    }
  }
  return matched;
}

/** What an authenticator app scans or accepts pasted. */
export function otpauthUri(secretBase32: string, email: string): string {
  const label = encodeURIComponent(`10XiD Portal:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: "10XiD Portal",
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* At rest                                                             */
/* ------------------------------------------------------------------ */

/**
 * The shared secret is encrypted before it is stored.
 *
 * Unlike a session token or a sign-in code, this one cannot be hashed — we have
 * to reproduce it to check a code. So it is encrypted with a key that lives in
 * the environment rather than the database, and a database dump on its own
 * yields no working second factor.
 *
 * Fails closed: with no key configured, enrolment refuses rather than quietly
 * storing secrets in the clear.
 */
function encryptionKey(): Buffer {
  const raw = process.env.TOTP_ENC_KEY;
  if (!raw) {
    throw new Error(
      "TOTP_ENC_KEY is not set, so second-factor secrets cannot be stored " +
        "safely. Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOTP_ENC_KEY must decode to 32 bytes for AES-256-GCM, got ${key.length}.`,
    );
  }
  return key;
}

export function encryptSecret(secretBase32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([
    cipher.update(secretBase32, "utf8"),
    cipher.final(),
  ]);
  // iv.tag.ciphertext, so the format carries everything needed to reverse it.
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, data] = stored.split(".");
  if (!iv || !tag || !data) throw new Error("Stored secret is malformed.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function secondFactorConfigured(): boolean {
  return Boolean(process.env.TOTP_ENC_KEY);
}
