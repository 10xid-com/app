import type { MembershipRole } from "@/lib/db/schema";

/**
 * Browsers cap every cookie at 400 days regardless of what the server asks for,
 * so no configuration above this is real. Liveness is decided from the session
 * row, never from the cookie's own expiry, because a browser can keep sending an
 * expired cookie indefinitely — but the reverse holds too: past this point the
 * browser stops sending the cookie whatever the row says, so a session that
 * claimed to last longer would only be pretending.
 */
export const MAX_COOKIE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Session policy (self-hosted sign-in, 0022).
 *
 * A portal session exists only as the far end of a sign-in on the login host,
 * and it lives no longer than that sign-in:
 *
 *   absolute   the sign-in's hard end — seven days from when the person signed
 *              in on the login host, never extended by activity. The portal
 *              row is created with exactly that end (auth_session_touch()).
 *   idle       48 hours without a request. Enforced on the portal row and, on
 *              every request, on the sign-in session it came from, which the
 *              database hides once it has been idle that long.
 *
 * Both are checked on the server on every request; the cookie's own expiry is
 * only a convenience for the browser. Revoking the sign-in on the login host
 * (signing out, a password reset, an operator) ends the portal session on its
 * next request.
 */

export type SessionRole = "client" | "staff";

export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_IDLE_SECONDS = 48 * 60 * 60;

export const SESSION_POLICY: Record<
  SessionRole,
  { idleSeconds: number | null; absoluteSeconds: number }
> = {
  client: { idleSeconds: SESSION_IDLE_SECONDS, absoluteSeconds: SESSION_ABSOLUTE_SECONDS },
  staff: { idleSeconds: SESSION_IDLE_SECONDS, absoluteSeconds: SESSION_ABSOLUTE_SECONDS },
};

/**
 * How recent the authenticator must be (login's /auth/mfa/again refreshes it):
 *
 *   agency      to use agency access at all — another business's records,
 *               through a grant — the authenticator within the last day;
 *   decision    to open a business to an agency (approve a grant, approve
 *               or unblock a person) — within the last five minutes, typed
 *               for the decision. Declining, blocking and ending access
 *               never wait on it.
 *
 * Paolo's decisions of 2026-10-08.
 */
export const FRESHNESS_SECONDS = {
  agency: 24 * 60 * 60,
  decision: 5 * 60,
} as const;

export type Freshness = keyof typeof FRESHNESS_SECONDS;

/** Sign-in codes are short-lived and few. */
export const SIGN_IN_CODE = {
  ttlSeconds: 10 * 60,
  maxAttempts: 5,
  /** Requests for a new code, per address, per window. */
  maxRequestsPerWindow: 5,
  requestWindowSeconds: 15 * 60,
};

/**
 * The cross-domain ticket is measured in seconds because it only has to survive
 * one redirect. Anything longer is a credential sitting in a browser's history.
 */
export const SSO_TICKET_TTL_SECONDS = 30;

/**
 * A staff grant covers one client for one working stretch, then lapses.
 *
 * This is the clock that matters now that sessions have none. Staying signed in
 * is convenience; reaching a particular client's data is the privilege, and it
 * stays bounded, still needs a reason typed at the moment of switching, and
 * still has to be asked for again afterwards.
 */
export const STAFF_GRANT_SECONDS = 30 * 60;

/**
 * The floor on a typed reason, shared with the staff-to-client grant.
 *
 * Eight characters does not make a reason good. It makes "." impossible, which
 * is the whole of what a minimum can do — the value of the field is that
 * somebody had to put words to what they were about to do while they were
 * doing it.
 */
export const GRANT_REASON_MIN = 8;
export const GRANT_REASON_MAX = 200;

/**
 * What one API key may file, per hour.
 *
 * A client's contact form is the thing on the other end, so this is sized for a
 * busy day rather than for a machine: sixty an hour is far more than any real
 * form produces and far less than a script pointed at the endpoint would. The
 * count comes from the database rather than from memory, because the
 * application runs as more than one instance.
 */
export const API_KEY_RATE = {
  maxJobsPerWindow: 60,
  windowSeconds: 60 * 60,
};

/**
 * WHAT MAKES A SESSION STAFF.
 *
 * Membership of the internal company used to be the whole of it:
 *
 *   const role = mships.some((m) => m.organizationType === "internal")
 *     ? "staff" : "client";
 *
 * which meant anybody added to the house — a bookkeeper, a summer student, an
 * account created to test something — silently held authority over every
 * client's data. The `staff` value in the membership_role enum existed and
 * meant nothing, so the field that looks like it answers this question did not.
 * 0013 found the live proof: an administrator who does the books held a staff
 * session, because he is in the house, though his membership says `member`.
 *
 * The rule now takes BOTH halves, and both are load-bearing:
 *
 *   organizationType === "internal"   the company is the house, not a client.
 *                                     A client company must never be able to
 *                                     mint authority over other clients by
 *                                     handing out a role inside its own walls.
 *   role === "staff"                   this person is here to work on clients'
 *                                     behalf, rather than merely being here.
 *
 * Neither alone is enough, which is why this is one function rather than two
 * predicates spelled out at each call site. It is pure, takes the memberships
 * as data, and lives in this file rather than beside the session so that the
 * four cases it decides can be pinned by tests without a cookie, a database or
 * a request: internal+staff is staff; internal+member is not; client+staff is
 * not; no membership is not.
 *
 * Widening it is deliberately awkward. Somebody who should be staff is given a
 * staff-role membership of the house — one row, in the table that already says
 * who is who — and never by being added to a company.
 */
export type RoleDerivationMembership = {
  organizationType: "client" | "internal";
  role: MembershipRole;
};

/** True for the one membership shape that confers staff: the house, as staff. */
export function isStaffMembership(m: RoleDerivationMembership): boolean {
  return m.organizationType === "internal" && m.role === "staff";
}

/**
 * The session role somebody's memberships add up to.
 *
 * Used by startSession() when a session is created.
 */
export function sessionRoleFor(
  memberships: readonly RoleDerivationMembership[],
): SessionRole {
  return memberships.some(isStaffMembership) ? "staff" : "client";
}

/**
 * WHICH BUSINESS IS ON SCREEN.
 *
 * The one this session chose (the business switcher, stored on the portal
 * session row), as long as the person is still a member of it; otherwise
 * their only business, if they have exactly one; otherwise none, and the
 * portal asks them to choose (/business).
 *
 * The choice is re-checked against live memberships on every request, so
 * being removed from a business takes it off screen on the next click rather
 * than when the session ends. The house is never a candidate: callers pass
 * client businesses only.
 */
export function activeBusiness(
  clientBusinessIds: readonly string[],
  chosen: string | null,
): string | null {
  if (chosen && clientBusinessIds.includes(chosen)) return chosen;
  return clientBusinessIds.length === 1 ? clientBusinessIds[0] : null;
}

/**
 * EVERY BUSINESS A PERSON MAY OPEN: their client memberships, then the
 * businesses their live agency grants reach (lib/db/agency.ts). A direct
 * membership wins over a grant into the same business — membership is what
 * the business itself decided, a grant only borrows.
 */
export type OpenableBusiness = {
  organizationId: string;
  organizationName: string;
  role: string;
  /** Set when this business is open to them only through an agency grant. */
  via: { grantId: string; agencyName: string; expiresAt: Date } | null;
};

export function openableBusinesses(
  memberships: readonly { organizationId: string; organizationName: string; organizationType: string; role: string }[],
  agencyAccess: readonly { grantId: string; organizationId: string; organizationName: string; agencyName: string; role: string; expiresAt: Date }[],
): OpenableBusiness[] {
  const out: OpenableBusiness[] = memberships
    .filter((m) => m.organizationType === "client")
    .map((m) => ({ organizationId: m.organizationId, organizationName: m.organizationName, role: m.role, via: null }));
  const direct = new Set(out.map((b) => b.organizationId));
  for (const a of agencyAccess) {
    if (direct.has(a.organizationId)) continue;
    direct.add(a.organizationId);
    out.push({
      organizationId: a.organizationId,
      organizationName: a.organizationName,
      role: a.role,
      via: { grantId: a.grantId, agencyName: a.agencyName, expiresAt: a.expiresAt },
    });
  }
  return out;
}
