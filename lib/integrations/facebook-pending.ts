import "server-only";
import { openToken, sealToken } from "./meta";

/**
 * While someone who manages several Facebook Pages chooses one, their
 * Facebook token waits in their own browser: sealed (./meta.ts), bound to
 * the business that is open and to who they are on Facebook, in an httpOnly
 * cookie that lasts fifteen minutes. The portal stores nothing until a Page
 * is chosen, and then only that Page's token.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";
export const FB_PENDING_COOKIE = `${SECURE ? "__Host-" : ""}portal_facebook_pending`;
const TTL_SECONDS = 15 * 60;

export function pendingCookieOptions(maxAge = TTL_SECONDS) {
  return { httpOnly: true, sameSite: "lax" as const, secure: SECURE, path: "/", maxAge };
}

const bound = (businessId: string, person: string) => ({ organizationId: businessId, channel: "facebook-pending", accountId: person });

export function sealPending(businessId: string, person: string, token: string): string {
  return `${person}.${sealToken(token, bound(businessId, person))}`;
}

/** The person's Facebook id and token, if the cookie is genuine and for this business. */
export function openPending(cookie: string | undefined, businessId: string): { person: string; token: string } | null {
  if (!cookie) return null;
  const at = cookie.indexOf(".");
  if (at < 1) return null;
  const person = cookie.slice(0, at);
  if (!/^\d{1,30}$/.test(person)) return null;
  try {
    return { person, token: openToken(cookie.slice(at + 1), bound(businessId, person)) };
  } catch {
    return null;
  }
}
