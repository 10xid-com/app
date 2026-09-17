import "server-only";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import {
  activeSessionsForUser,
  consumeTicketsForSession,
  insertSession,
  liveGrantForSession,
  membershipsForUser,
  revokeAllSessionsForUser,
  revokeSession,
  sessionByTokenHash,
  touchSession,
  userById,
} from "@/lib/db/identity";
import type { Scope } from "@/lib/db";
import { secretToken } from "@/lib/ids";
import {
  MAX_COOKIE_SECONDS,
  SESSION_POLICY,
  type SessionRole,
} from "./policy";

/**
 * The session cookie carries a random value and nothing else. It is a lookup
 * key, never a claim — there is no role, no company and no expiry inside it
 * that a caller could tamper with, and only its hash is stored, so reading the
 * database yields no usable session.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";

/**
 * The `__Host-` prefix is enforced by the browser itself: a cookie carrying it
 * must be Secure, must have Path=/, and must have NO Domain attribute. That
 * last part is the valuable one — it makes the cookie unable to be set for this
 * host by any sibling subdomain, which removes a whole class of attack for
 * free. It requires a secure context, so plain-HTTP local development falls
 * back to an unprefixed name; every deployed environment gets the prefix.
 */
export const SESSION_COOKIE = SECURE
  ? "__Host-portal_session"
  : "portal_session";

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type SessionContext = {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: SessionRole;
  scope: Scope;
  memberships: Awaited<ReturnType<typeof membershipsForUser>>;
  absoluteExpiresAt: Date;
  idleSeconds: number | null;
  /** When this session cleared its second factor, if it has. */
  secondFactorAt: Date | null;
  /** True for a staff session that has passed the email code and nothing else. */
  needsSecondFactor: boolean;
};

/** Which host this request arrived on. Used for cookies and branding only. */
export async function currentHost(): Promise<string> {
  const h = await headers();
  return (h.get("host") ?? "").toLowerCase();
}

/**
 * Establish a session for someone who has just proved who they are.
 *
 * The role is read from their memberships, never from anything the caller sent.
 * Both clocks are resolved here and written onto the row, so the session's
 * limits are fixed at the moment it is created.
 */
export async function startSession(input: {
  userId: string;
  host: string;
  /**
   * True when the thing that was just checked WAS the second factor — an
   * authenticator code, or a recovery code standing in for one. Such a session
   * starts already cleared, because sending it to the enrolment screen would be
   * asking for the same code twice in a row.
   *
   * It is passed in by the caller that did the checking rather than inferred
   * here, so there is no way for this function to assume a factor was presented
   * when it was not.
   */
  secondFactorPassed?: boolean;
}): Promise<{ token: string; sessionId: string; role: SessionRole }> {
  const mships = await membershipsForUser(input.userId);
  const role: SessionRole = mships.some((m) => m.organizationType === "internal")
    ? "staff"
    : "client";

  const policy = SESSION_POLICY[role];
  const token = secretToken(32);

  // A client belonging to exactly one company is scoped to it immediately.
  // Staff start unscoped: they must choose a client and give a reason.
  const clientOrgs = mships.filter((m) => m.organizationType === "client");
  const activeOrganizationId =
    role === "client" && clientOrgs.length === 1
      ? clientOrgs[0].organizationId
      : null;

  const session = await insertSession({
    userId: input.userId,
    tokenHash: hashToken(token),
    issuedForHost: input.host.toLowerCase(),
    idleSeconds: policy.idleSeconds,
    absoluteExpiresAt: new Date(Date.now() + policy.absoluteSeconds * 1000),
    roleAtCreation: role,
    activeOrganizationId,
    secondFactorAt: input.secondFactorPassed ? new Date() : null,
  });

  return { token, sessionId: session.id, role };
}

export async function writeSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  const maxAge = Math.max(
    0,
    Math.min(
      MAX_COOKIE_SECONDS,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    ),
  );
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: Strict means arriving from a link in a notification
    // email lands you signed out until you reload, which is exactly the
    // "it randomly logs me out" experience this design exists to avoid.
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge: 0,
  });
}

/**
 * Resolve the current session, enforcing both clocks.
 *
 * Liveness comes from the database row, never from the cookie — a browser can
 * keep sending a cookie long after it was supposed to lapse, so the cookie's
 * own expiry is a convenience for the browser and nothing more.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await sessionByTokenHash(hashToken(token));
  if (!session) return null;

  const now = Date.now();

  // Absolute cap: renewal can never push past it.
  if (session.absoluteExpiresAt.getTime() <= now) {
    await revokeSession(session.id);
    return null;
  }

  // Idle clock: restarts on every visit, when the role has one at all.
  if (session.idleSeconds !== null) {
    const idleDeadline =
      session.lastSeenAt.getTime() + session.idleSeconds * 1000;
    if (idleDeadline <= now) {
      await revokeSession(session.id);
      return null;
    }
  }

  const user = await userById(session.userId);
  if (!user) {
    await revokeSession(session.id);
    return null;
  }

  await touchSession(session.id);

  const mships = await membershipsForUser(session.userId);
  const role = session.roleAtCreation as SessionRole;

  /**
   * A staff session that has not cleared its second factor carries no
   * authority at all.
   *
   * The redirect to the enrolment screen is the visible half; this is the half
   * that matters. Even if some route forgets to redirect, the scope it receives
   * is not staff and is bound to no client, so it can read nothing — the check
   * is in what the session grants, not only in where it is sent.
   */
  const needsSecondFactor = role === "staff" && session.secondFactorAt === null;
  const isStaff = role === "staff" && !needsSecondFactor;

  // For staff the scope comes from a live grant, so it lapses on its own
  // rather than lasting as long as the session does.
  let organizationId = needsSecondFactor ? null : session.activeOrganizationId;
  if (isStaff) {
    const grant = await liveGrantForSession(session.id);
    organizationId = grant?.organizationId ?? null;
  }

  return {
    sessionId: session.id,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role,
    scope: {
      userId: user.id,
      email: user.email,
      isStaff,
      organizationId,
    },
    memberships: mships,
    absoluteExpiresAt: session.absoluteExpiresAt,
    idleSeconds: session.idleSeconds,
    secondFactorAt: session.secondFactorAt,
    needsSecondFactor,
  };
}

/**
 * Sign out everywhere, immediately.
 *
 * Every domain holds its own cookie and we cannot reach across to delete them —
 * but a cookie is only a key, and every row it could point at is now revoked.
 * The next request from any domain finds nothing. There is no window during
 * which a previously issued token still works, which is the trade a
 * short-lived-token design makes and this one does not.
 */
export async function signOutEverywhere(userId: string, sessionId: string) {
  await consumeTicketsForSession(sessionId);
  const count = await revokeAllSessionsForUser(userId);
  await clearSessionCookie();
  return count;
}

export async function signOutThisSession(sessionId: string) {
  await consumeTicketsForSession(sessionId);
  await revokeSession(sessionId);
  await clearSessionCookie();
}

export { activeSessionsForUser };
