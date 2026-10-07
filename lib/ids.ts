import { randomBytes, randomInt } from "node:crypto";

/**
 * UUIDv7 — a time-ordered identifier with 74 random bits.
 *
 * Used for anything that appears in a URL. Sequential integers would let anyone
 * count the jobs in the system and walk through them; a fully random v4 keeps
 * that secrecy but fragments the database index as the table grows. v7 puts the
 * timestamp in the high bits so rows insert in order, and keeps enough
 * randomness that an identifier cannot be guessed.
 *
 * Postgres 16 has no native uuidv7(), so this is generated here rather than by
 * a column default. Postgres 18 adds one; this stays authoritative either way.
 *
 * Layout (RFC 9562): 48-bit millisecond timestamp | version 7 | 12 random bits
 * | variant | 62 random bits.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());

  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * A URL-safe secret. Used for session cookies and handoff tickets, where the
 * value is only ever a lookup key and is stored as its hash.
 */
export function secretToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * A six-digit sign-in code, drawn from a cryptographic source rather than
 * Math.random. Leading zeros are preserved — "004821" is a valid code, and
 * dropping it would quietly shrink the keyspace.
 */
export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
