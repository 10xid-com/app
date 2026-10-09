import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A channel's sign-in round trip (Instagram, Facebook): a random value sent
 * to the provider and kept in this browser's cookie with the business it was
 * started for. The callback accepts a code only when the provider hands back
 * the same value, in the same browser, for the business that is still open —
 * so nobody can make someone else's session connect an account of their
 * choosing.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";
const TTL_SECONDS = 600;

export type OAuthChannel = "instagram" | "facebook";

export const stateCookieName = (channel: OAuthChannel) => `${SECURE ? "__Host-" : ""}portal_${channel}_state`;

export function newOAuthState(businessId: string): { state: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  return { state, cookie: `${state}.${businessId}` };
}

export function oauthCookieOptions(maxAge = TTL_SECONDS) {
  return { httpOnly: true, sameSite: "lax" as const, secure: SECURE, path: "/", maxAge };
}

/** Does the returned state match the cookie, for this business? */
export function oauthStateMatches(cookie: string | undefined, returned: string | null, businessId: string): boolean {
  if (!cookie || !returned) return false;
  const at = cookie.indexOf(".");
  if (at < 1 || cookie.slice(at + 1) !== businessId) return false;
  const a = Buffer.from(cookie.slice(0, at));
  const b = Buffer.from(returned);
  return a.length === b.length && timingSafeEqual(a, b);
}
