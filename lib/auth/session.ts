import "server-only";
import { cache } from "react";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { membershipsForUser } from "@/lib/db/identity";
import { openBindingFor, userByWorkosId } from "@/lib/db/workos";
import type { Scope } from "@/lib/db";
import type { SessionRole } from "./policy";

/**
 * Who is making this request.
 *
 * WorkOS AuthKit answers who signed in: its sealed, host-only session cookie,
 * refreshed by proxy.ts, read here through the official SDK. This database
 * answers what that person may do, and the first half of that is finding the
 * local account bound to the WorkOS user id (users.workos_user_id). An address
 * is never used to find the account here — that happened once, at the
 * callback, and only an invitation or an operator could turn it into a binding.
 *
 * Nothing in this file grants anything. What the person may do is decided by
 * the central authorization function, ./authorize.ts.
 */

/**
 * Where a signed-in WorkOS user stands locally.
 *
 *   signed_out     no WorkOS session.
 *   impersonated   a WorkOS dashboard impersonation. Refused: it is staff access
 *                  by another door, and staff access is off (2026-10-07).
 *   unbound        signed in to WorkOS, but no local account is bound to the
 *                  WorkOS user. `pendingBinding` says whether an operator has a
 *                  request to look at.
 *   active         a bound, live account.
 */
export type Identity =
  | { state: "signed_out" }
  | { state: "impersonated"; workosUserId: string; sessionId: string }
  | {
      state: "unbound";
      workosUserId: string;
      sessionId: string;
      email: string;
      emailVerified: boolean;
      pendingBinding: boolean;
    }
  | { state: "active"; workosUserId: string; sessionId: string; ctx: SessionContext };

/**
 * The signed-in person, in the shape the portal's pages have always read.
 *
 * The staff and act-as fields are kept, fixed at "no", because the screens
 * that read them are still in the code, turned off rather than deleted (see
 * ./authorize.ts). Nothing can set them: there is no staff session and no
 * act-as grant under WorkOS.
 */
export type SessionContext = {
  /** The WorkOS session id (`session_...`). Not a row in the local `sessions` table. */
  sessionId: string;
  workosUserId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: SessionRole;
  scope: Scope;
  memberships: Awaited<ReturnType<typeof membershipsForUser>>;
  /** Always false: WorkOS enforces the second factor before a session exists. */
  needsSecondFactor: false;
  realUserId: string;
  realEmail: string;
  /** Always false: staff access is off. */
  realIsStaff: false;
  /**
   * Always null: there is no acting as anybody. Typed as the grant it used to
   * be so the act-as screens, turned off rather than deleted, still compile.
   */
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

/** Once per request: the shell, the page and its forms all ask. */
export const resolveIdentity = cache(async function resolveIdentity(): Promise<Identity> {
  const auth = await withAuth();
  if (!auth.user) return { state: "signed_out" };
  if (auth.impersonator) {
    return { state: "impersonated", workosUserId: auth.user.id, sessionId: auth.sessionId };
  }

  const user = await userByWorkosId(auth.user.id);
  if (!user) {
    return {
      state: "unbound",
      workosUserId: auth.user.id,
      sessionId: auth.sessionId,
      email: auth.user.email,
      emailVerified: auth.user.emailVerified,
      pendingBinding: (await openBindingFor(auth.user.id)) !== null,
    };
  }

  const memberships = await membershipsForUser(user.id);

  /**
   * Which business is on screen: the one client business this person belongs
   * to, or none if they belong to several or to none — exactly what the
   * portal did before WorkOS. Choosing between several businesses is an open
   * rule in the build brief (rule set 1, "switching businesses"), so it is not
   * invented here. The house (Branding Centres, `internal`) is never one:
   * membership of it carried staff access, which is off.
   */
  const clientBusinesses = memberships.filter((m) => m.organizationType === "client");
  const organizationId =
    clientBusinesses.length === 1 ? clientBusinesses[0].organizationId : null;

  const ctx: SessionContext = {
    sessionId: auth.sessionId,
    workosUserId: auth.user.id,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: "client",
    scope: {
      userId: user.id,
      email: user.email,
      isStaff: false,
      organizationId,
      actingAs: null,
    },
    memberships,
    needsSecondFactor: false,
    realUserId: user.id,
    realEmail: user.email,
    realIsStaff: false,
    actingAs: null,
  };
  return { state: "active", workosUserId: auth.user.id, sessionId: auth.sessionId, ctx };
});

/** The active session, or null for anybody who is not a bound, live account. */
export async function getSessionContext(): Promise<SessionContext | null> {
  const identity = await resolveIdentity();
  return identity.state === "active" ? identity.ctx : null;
}
