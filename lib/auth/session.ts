import "server-only";
import { createHash } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import {
  insertSession,
  markSecondFactorPassed,
  membershipsForUser,
  revokeSession,
  sessionByTokenHash,
  touchSession,
  userById,
} from "@/lib/db/identity";
import type { Scope } from "@/lib/db";
import { secretToken } from "@/lib/ids";
import { csrfTokenFor } from "./csrf";
import {
  activeBusiness,
  openableBusinesses,
  PENDING_SESSION_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  type SessionRole,
} from "./policy";
import { liveAgencyAccessFor, type AgencyAccess } from "@/lib/db/agency";

/**
 * Who is making this request.
 *
 * The portal signs people in itself (lib/auth/codes.ts, app/auth/*): an
 * emailed code, then the authenticator app, every time. A session is a random
 * value in a host-only cookie, only its hash stored, pointing at a row in
 * `sessions`. On every request that row is checked:
 *
 *   * not revoked, inside its absolute end (seven days from signing in) and
 *     active within 48 hours;
 *   * not a session handed over from login.10xid.com (source_auth_session_id
 *     set) — those are refused, so everybody signs in here once;
 *   * past the authenticator (second_factor_at). Until then the session is
 *     "pending": it opens the authenticator screens and nothing else, and
 *     lapses after fifteen minutes.
 *
 * Nothing in this file grants anything. What the person may do is decided by
 * the central authorization function, ./authorize.ts.
 */

const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";

/**
 * Host-only by construction: the `__Host-` prefix makes the browser refuse
 * the cookie unless it is Secure, Path=/ and has no Domain attribute, so no
 * sibling subdomain can read or plant it. Plain-HTTP local development falls
 * back to an unprefixed name.
 */
export const SESSION_COOKIE = SECURE ? "__Host-portal_session" : "portal_session";

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Somebody past the emailed code and not yet past the authenticator. */
export type PendingSignIn = {
  sessionId: string;
  userId: string;
  email: string;
  /** Whether they have an authenticator to type from, or are setting one up. */
  enrolled: boolean;
};

export type Identity =
  | { state: "signed_out" }
  | { state: "pending"; sessionId: string; csrfToken: string; pending: PendingSignIn }
  | { state: "active"; sessionId: string; csrfToken: string; ctx: SessionContext };

/**
 * The signed-in person, in the shape the portal's pages have always read.
 *
 * There is no acting as anybody: somebody working in another business does
 * it as themselves, through an agency grant (`agencyAccess`).
 */
export type SessionContext = {
  /** The portal session (`sessions.id`). */
  sessionId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: SessionRole;
  scope: Scope;
  memberships: Awaited<ReturnType<typeof membershipsForUser>>;
  /** Client businesses open to this person through live agency grants (lib/db/agency.ts). */
  agencyAccess: AgencyAccess[];
  absoluteExpiresAt: Date;
  /** When this session last passed the authenticator (sign-in, or /auth/confirm). */
  secondFactorAt: Date;
  /** Always false: an active session has passed the authenticator. */
  needsSecondFactor: false;
};

export async function currentHost(): Promise<string> {
  return ((await headers()).get("host") ?? "").toLowerCase();
}

/**
 * The session the emailed code produces: pending, good for fifteen minutes,
 * for the authenticator screens only.
 */
export async function startPendingSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = secretToken(32);
  const expiresAt = new Date(Date.now() + PENDING_SESSION_SECONDS * 1000);
  await insertSession({
    userId,
    tokenHash: hashToken(token),
    issuedForHost: await currentHost(),
    idleSeconds: PENDING_SESSION_SECONDS,
    absoluteExpiresAt: expiresAt,
    roleAtCreation: "client",
    activeOrganizationId: null,
    secondFactorAt: null,
  });
  return { token, expiresAt };
}

/**
 * Past the authenticator: the pending session is ended and a new one issued
 * under a new token, so the value that existed before the second factor never
 * carries authority.
 */
export async function completeSignIn(pendingSessionId: string, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const [memberships, agencyAccess] = await Promise.all([membershipsForUser(userId), liveAgencyAccessFor(userId)]);
  const openable = openableBusinesses(memberships, agencyAccess);
  const token = secretToken(32);
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_SECONDS * 1000);
  await revokeSession(pendingSessionId);
  await insertSession({
    userId,
    tokenHash: hashToken(token),
    issuedForHost: await currentHost(),
    idleSeconds: SESSION_IDLE_SECONDS,
    absoluteExpiresAt: expiresAt,
    roleAtCreation: "client",
    activeOrganizationId: openable.length === 1 ? openable[0].organizationId : null,
    secondFactorAt: new Date(),
  });
  return { token, expiresAt };
}

/** "Confirm it is you": the authenticator typed again, on the same session. */
export async function refreshSecondFactor(sessionId: string): Promise<void> {
  await markSecondFactorPassed(sessionId);
}

export async function writeSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax: arriving from a link in an email must not land somebody signed
    // out. Cross-site POSTs still carry no cookie, and the Origin and CSRF
    // checks stop same-site ones.
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: SECURE, path: "/", maxAge: 0 });
}

/** Once per request: the shell, the page and its forms all ask. */
export const resolveIdentity = cache(async function resolveIdentity(): Promise<Identity> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { state: "signed_out" };

  const session = await sessionByTokenHash(hashToken(token));
  if (!session) return { state: "signed_out" };

  const end = async () => {
    await revokeSession(session.id);
    return { state: "signed_out" } as const;
  };

  const now = Date.now();
  // Handed over from login.10xid.com, before the portal signed people in.
  if (session.sourceAuthSessionId || session.sourceSessionId) return end();
  if (session.absoluteExpiresAt.getTime() <= now) return end();
  const idle = session.idleSeconds ?? SESSION_IDLE_SECONDS;
  if (session.lastSeenAt.getTime() + idle * 1000 <= now) return end();

  const user = await userById(session.userId);
  if (!user || user.deletedAt || user.isService) return end();

  if (!session.secondFactorAt) {
    return {
      state: "pending",
      sessionId: session.id,
      csrfToken: csrfTokenFor(token),
      pending: {
        sessionId: session.id,
        userId: user.id,
        email: user.email,
        enrolled: Boolean(user.totpSecret && user.totpConfirmedAt),
      },
    };
  }

  await touchSession(session.id);
  const [memberships, agencyAccess] = await Promise.all([
    membershipsForUser(user.id),
    liveAgencyAccessFor(user.id),
  ]);

  // Which business is on screen: see activeBusiness() in ./policy.ts. A
  // business reached through an agency grant counts as much as a membership,
  // and stops counting the moment the grant does.
  const organizationId = activeBusiness(
    openableBusinesses(memberships, agencyAccess).map((b) => b.organizationId),
    session.activeOrganizationId,
  );

  const ctx: SessionContext = {
    sessionId: session.id,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: "client",
    scope: { userId: user.id, email: user.email, isStaff: false, organizationId },
    memberships,
    agencyAccess,
    absoluteExpiresAt: session.absoluteExpiresAt,
    secondFactorAt: session.secondFactorAt,
    needsSecondFactor: false,
  };
  return { state: "active", sessionId: session.id, csrfToken: csrfTokenFor(token), ctx };
});

/** The active session, or null. */
export async function getSessionContext(): Promise<SessionContext | null> {
  const identity = await resolveIdentity();
  return identity.state === "active" ? identity.ctx : null;
}
