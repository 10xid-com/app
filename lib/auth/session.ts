import "server-only";
import { createHash } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import {
  insertSession,
  membershipsForUser,
  revokeSession,
  sessionByTokenHash,
  touchSession,
  userById,
} from "@/lib/db/identity";
import { touchAuthSession } from "@/lib/db/auth-session";
import type { Scope } from "@/lib/db";
import { secretToken } from "@/lib/ids";
import { csrfTokenFor } from "./csrf";
import { activeBusiness, openableBusinesses, SESSION_IDLE_SECONDS, type SessionRole } from "./policy";
import { liveAgencyAccessFor, type AgencyAccess } from "@/lib/db/agency";

/**
 * Who is making this request.
 *
 * Signing in happens on the login host (login.10xid.com, Better Auth), never
 * here. The portal receives a session of its own through the single-use
 * ticket handoff (app/auth/sso/*): a random value in a host-only cookie, only
 * its hash stored, pointing at a row in `sessions` that names the sign-in it
 * came from. On every request that row is checked AND the sign-in behind it:
 *
 *   * the row is not revoked, inside its absolute end (the sign-in's hard
 *     end, seven days from signing in) and active within 48 hours;
 *   * it came from a sign-in on the login host (source_auth_session_id) —
 *     sessions from before 0022 are refused, so everybody signs in again;
 *   * that sign-in is still live and has passed the authenticator
 *     (auth_session_touch), so signing out there, a password reset or an
 *     operator's revocation ends this session on its next request.
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

export type Identity =
  | { state: "signed_out" }
  | { state: "active"; sessionId: string; csrfToken: string; ctx: SessionContext };

/**
 * The signed-in person, in the shape the portal's pages have always read.
 *
 * The staff and act-as fields are kept, fixed at "no", because the screens
 * that read them are still in the code, turned off rather than deleted (see
 * ./authorize.ts). Nothing can set them.
 */
export type SessionContext = {
  /** The portal session (`sessions.id`). */
  sessionId: string;
  /** The sign-in session on the login host it came from. */
  authSessionId: string;
  /** The sign-in identity (Better Auth user) the account is bound to. */
  authUserId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: SessionRole;
  scope: Scope;
  memberships: Awaited<ReturnType<typeof membershipsForUser>>;
  /** Client businesses open to this person through live agency grants (lib/db/agency.ts). */
  agencyAccess: AgencyAccess[];
  absoluteExpiresAt: Date;
  /** Always false: the login host requires the authenticator before any handoff. */
  needsSecondFactor: false;
  realUserId: string;
  realEmail: string;
  /** Always false: staff access is off. */
  realIsStaff: false;
  /** Always null: there is no acting as anybody. */
  actingAs: {
    grantId: string;
    userId: string;
    email: string;
    fullName: string | null;
    reason: string;
    startedAt: Date;
    expiresAt: Date;
  } | null;
};

/**
 * Create the portal session at the end of a handoff. Its absolute end is the
 * sign-in's own (`hardEnd`), so it can never outlive it.
 */
export async function startSession(input: {
  userId: string;
  host: string;
  authSessionId: string;
  hardEnd: Date;
}): Promise<{ token: string; sessionId: string }> {
  const [memberships, agencyAccess] = await Promise.all([
    membershipsForUser(input.userId),
    liveAgencyAccessFor(input.userId),
  ]);
  const openable = openableBusinesses(memberships, agencyAccess);
  const token = secretToken(32);
  const session = await insertSession({
    userId: input.userId,
    tokenHash: hashToken(token),
    issuedForHost: input.host.toLowerCase(),
    idleSeconds: SESSION_IDLE_SECONDS,
    absoluteExpiresAt: input.hardEnd,
    roleAtCreation: "client",
    activeOrganizationId: openable.length === 1 ? openable[0].organizationId : null,
    // The login host required the authenticator before minting the ticket.
    secondFactorAt: new Date(),
    sourceAuthSessionId: input.authSessionId,
  });
  return { token, sessionId: session.id };
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
  if (!session.sourceAuthSessionId) return end();
  if (session.absoluteExpiresAt.getTime() <= now) return end();
  const idle = session.idleSeconds ?? SESSION_IDLE_SECONDS;
  if (session.lastSeenAt.getTime() + idle * 1000 <= now) return end();

  const user = await userById(session.userId);
  if (!user || user.deletedAt || user.isService || !user.authUserId) return end();

  // The sign-in it came from: live, past the authenticator, and recorded as
  // active by this request (so using the portal keeps both alive, within the
  // seven days).
  const hardEnd = await touchAuthSession(session.sourceAuthSessionId);
  if (!hardEnd) return end();

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
    authSessionId: session.sourceAuthSessionId,
    authUserId: user.authUserId,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: "client",
    scope: { userId: user.id, email: user.email, isStaff: false, organizationId, actingAs: null },
    memberships,
    agencyAccess,
    absoluteExpiresAt: new Date(Math.min(session.absoluteExpiresAt.getTime(), hardEnd.getTime())),
    needsSecondFactor: false,
    realUserId: user.id,
    realEmail: user.email,
    realIsStaff: false,
    actingAs: null,
  };
  return { state: "active", sessionId: session.id, csrfToken: csrfTokenFor(token), ctx };
});

/** The active session, or null. */
export async function getSessionContext(): Promise<SessionContext | null> {
  const identity = await resolveIdentity();
  return identity.state === "active" ? identity.ctx : null;
}
