import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { safePath } from "./paths";

/**
 * Cross-domain sign-in: the portal's half.
 *
 * The login host (login.10xid.com) and the portal (app.10xid.com) never share
 * a cookie: each is host-only. The browser is handed across by a top-level
 * redirect carrying a single-use ticket — the OAuth authorization-code shape:
 *
 *   1. /auth/sso/start (here)        a state value in this host's own cookie;
 *                                    the browser goes to the login host with
 *                                    this site's id and the state.
 *   2. /auth/sso/authorize (login)   signed in, past the authenticator, bound to
 *                                    an account? A ticket — 30 seconds, hashed
 *                                    at rest, for this host only — comes back.
 *   3. /auth/sso/callback (here)     the state must match this browser's
 *                                    cookie; the ticket is spent atomically,
 *                                    once; this host issues its own session.
 *
 * The return path never leaves this host (it rides in the state cookie), so
 * nothing on the round trip can choose where the person lands.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";

/** The state cookie only has to survive one redirect. */
export const SSO_STATE_COOKIE = SECURE ? "__Host-portal_sso_state" : "portal_sso_state";
export const SSO_STATE_TTL_SECONDS = 120;

export function hashTicket(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type SsoState = { state: string; path: string };

export function encodeState(value: SsoState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeState(raw: string | undefined): SsoState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.state !== "string") return null;
    return { state: parsed.state, path: safePath(parsed.path) };
  } catch {
    return null;
  }
}

/**
 * Compare the state the browser brought back with the one this site issued.
 * This is what stops login CSRF: without it, someone could hand a victim's
 * browser a ticket for the ATTACKER'S account and sign them into it.
 */
export function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export const stateCookieOptions = (maxAge: number) => ({
  httpOnly: true,
  // Lax is required: the browser comes BACK by a top-level GET redirect from
  // the login host, and Lax allows the cookie on exactly that navigation.
  sameSite: "lax" as const,
  secure: SECURE,
  path: "/",
  maxAge,
});
