import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A CSRF token bound to the portal session.
 *
 * The second, independent half of the check on every state-changing request
 * (the first is the exact Origin, ./origin.ts). The token is an HMAC keyed by
 * the session's own secret — the random value in the host-only, HttpOnly
 * session cookie — so it needs no storage and no further secret, stops working
 * the moment the session is replaced, and cannot be computed by anybody who
 * does not already hold the cookie. A page on another origin cannot read it
 * (it is only ever rendered into the portal's own HTML).
 */

export { CSRF_FIELD, CSRF_HEADER } from "./csrf-names";

export function csrfTokenFor(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update("10xid portal csrf v1").digest("base64url");
}

export function isValidCsrfToken(token: unknown, expected: string | null | undefined): boolean {
  if (typeof token !== "string" || token.length === 0 || !expected) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
