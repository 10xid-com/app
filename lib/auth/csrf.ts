import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A CSRF token bound to the WorkOS session.
 *
 * Revision 2 asks for an exact Origin AND CSRF protection on every
 * state-changing request; the Origin check is in ./origin.ts and this is the
 * second, independent half. A token is an HMAC of the WorkOS session id, so it
 * needs no storage and stops working the moment that session ends. A page on
 * another origin cannot read it (it is only ever rendered into the portal's own
 * HTML), so it cannot put it in a forged form.
 *
 * The key is derived from WORKOS_COOKIE_PASSWORD under its own label, so the
 * secret that seals the session cookie is never used directly for anything
 * else, and no further secret needs configuring.
 */

export const CSRF_FIELD = "csrf";
export const CSRF_HEADER = "x-csrf-token";

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("10xid csrf v1").digest();
}

export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHmac("sha256", key(secret)).update(`session:${sessionId}`).digest("base64url");
}

export function isValidCsrfToken(
  token: unknown,
  sessionId: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  if (!sessionId || !secret) return false;
  const expected = Buffer.from(csrfTokenFor(sessionId, secret), "utf8");
  const presented = Buffer.from(token, "utf8");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

export function csrfSecret(): string | null {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  return secret && secret.length >= 32 ? secret : null;
}
