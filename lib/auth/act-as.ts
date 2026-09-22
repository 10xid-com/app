import "server-only";
import {
  ACT_AS_GRANT_SECONDS,
  ACT_AS_STAFF_CAPABILITY,
  GRANT_REASON_MAX,
  GRANT_REASON_MIN,
  isStaffMembership,
} from "./policy";
import { canInAny } from "@/lib/db/access";
import {
  createActAsGrant,
  endActAsGrantsForSession,
  membershipsForUser,
  userById,
} from "@/lib/db/identity";

/**
 * Whether somebody may become somebody else, decided in one place.
 *
 * This module DECIDES; lib/db/identity.ts WRITES. Keeping them apart is what
 * makes the rules testable without a browser, a cookie or a redirect — the
 * server action in app/act-as/actions.ts is a thin wrapper that turns a form
 * into these arguments and a refusal into a message, and holds no rule of its
 * own. A rule that lives in a server action is a rule that is only ever
 * exercised by clicking.
 *
 * The four properties this is built to have, and where each one is:
 *
 *   1. NO PERMANENT TAKEOVER. Not here — it is in lib/auth/require.ts and the
 *      routes that call it. Impersonation lets you see what somebody sees and
 *      do their work; it must never let you walk away owning their account, so
 *      changing their address, enrolling an authenticator and reading their
 *      recovery codes are refused for the duration.
 *   2. NO CHAINING. `alreadyActingAs` below. Acting as Joel you may renew
 *      Joel, and you may not become anybody else — come back to yourself
 *      first. Without this, one grant on a staff colleague would be a ladder
 *      to every account in the building, and the audit would show Paolo
 *      becoming Joel and then a trail that looks like Joel's own doing.
 *   3. TIME-BOXED AND VISIBLE. ACT_AS_GRANT_SECONDS, and the banner in
 *      app/portal-shell.tsx, which is rendered by the shell itself rather than
 *      passed in by each page — a banner a page can forget is not a guarantee.
 *   4. LOGGED. Every path that returns `ok` has written a row carrying the
 *      reason. There is no way to start one without one.
 *
 * WHO MAY BE TARGETED. Paolo asked for no restriction — anyone, staff
 * included, until further notice. That is implemented as a capability rather
 * than as his address in an `if`: targeting a non-staff account needs a staff
 * session, and targeting a STAFF account additionally needs
 * `user.act_as.staff` held in an internal organization. "Until further notice"
 * is then a revocable row in `permissions`, which is what that table is for,
 * and withdrawing it is one UPDATE rather than a deploy.
 */

export const ACT_AS_REFUSALS = {
  not_staff:
    "Only a staff session can act as somebody else.",
  second_factor:
    "This session has not passed its second step yet.",
  chaining:
    "You are already acting as somebody. Stop first — you cannot become a second person from inside the first.",
  reason:
    `Give a reason of at least ${GRANT_REASON_MIN} characters. It goes in the record and cannot be added afterwards.`,
  unknown_target: "That account no longer exists.",
  service_account:
    "That is a service account. It cannot sign in, so there is no side of it to see.",
  self: "You are already yourself.",
  needs_capability:
    `That account is staff. Acting as staff needs the ${ACT_AS_STAFF_CAPABILITY} capability, granted in the internal organization.`,
} as const;

export type ActAsRefusal = keyof typeof ACT_AS_REFUSALS;

export type StartActingAsResult =
  | { ok: true; grantId: string; targetUserId: string; expiresAt: Date }
  | { ok: false; refusal: ActAsRefusal };

/**
 * The real identity behind a request, and what it is allowed to do with it.
 *
 * Every field here is about the REAL person, never the one being appeared as.
 * That distinction is the whole security boundary: while acting as a client,
 * `scope.isStaff` is false — correctly, because the point is to see what they
 * see — so a check written against the session's effective identity would let
 * a staff session launder itself into a client one and lose its own rules.
 * `realIsStaff` and `realUserId` come straight off the session row and the
 * account it belongs to.
 */
export type ActAsRequest = {
  sessionId: string;
  realUserId: string;
  realIsStaff: boolean;
  needsSecondFactor: boolean;
  /** The target of the grant currently in force, if any. */
  actingAsUserId: string | null;
  targetUserId: string;
  reason: string;
};

/** May the real actor target a STAFF account? A capability, not a name. */
export async function mayActAsStaff(realUserId: string): Promise<boolean> {
  const internalOrgIds = (await membershipsForUser(realUserId))
    .filter((m) => m.organizationType === "internal")
    .map((m) => m.organizationId);
  return canInAny(internalOrgIds, realUserId, ACT_AS_STAFF_CAPABILITY);
}

/**
 * Start acting as somebody, or say exactly why not.
 *
 * The order of the checks matters in one place only, and it is deliberate:
 * staff-ness is established before anything reads the target, so a session
 * that may not do this at all cannot use the refusals to find out who exists.
 */
export async function startActingAs(
  input: ActAsRequest,
): Promise<StartActingAsResult> {
  // 1. Only a staff session, and only one that has finished authenticating.
  //    Read off the REAL identity: a staff session that is currently a client
  //    is still a staff session, and a client session never becomes one.
  if (!input.realIsStaff) return { ok: false, refusal: "not_staff" };
  if (input.needsSecondFactor) return { ok: false, refusal: "second_factor" };

  // 2. No chaining. Renewing the person you are already being is not chaining
  //    — it is the same identity with a new hour and a newly typed reason —
  //    but becoming anybody else from inside somebody is.
  if (
    input.actingAsUserId !== null &&
    input.actingAsUserId !== input.targetUserId
  ) {
    return { ok: false, refusal: "chaining" };
  }

  // 3. A reason, always. Trimmed here rather than trusted from the form.
  const reason = input.reason.trim().slice(0, GRANT_REASON_MAX);
  if (reason.length < GRANT_REASON_MIN) return { ok: false, refusal: "reason" };

  // 4. The target has to be a person who can sign in.
  if (input.targetUserId === input.realUserId) {
    return { ok: false, refusal: "self" };
  }
  const target = await userById(input.targetUserId);
  if (!target) return { ok: false, refusal: "unknown_target" };
  if (target.isService) return { ok: false, refusal: "service_account" };

  // 5. Staff targets need the capability as well as the staff session.
  //
  //    Two sources, OR'd, and the OR is the point. isStaffMembership() is what
  //    the SESSION derives from — a `staff`-role membership of the house — so
  //    asking it here means this check and the session agree about who is
  //    staff. `target.isStaff` is the stored copy of the same fact; it is kept
  //    in the test because a copy can drift, and a drifted flag must cost an
  //    extra permission rather than skip one. Erring towards "staff" is the
  //    safe direction: the worst it does is ask for a capability that was not
  //    strictly needed.
  //
  //    The membership half used to be `organizationType === "internal"` alone,
  //    which treated everyone in the house as a staff target — the same defect
  //    the session had, in the same words.
  const targetMemberships = await membershipsForUser(target.id);
  const targetIsStaff =
    target.isStaff || targetMemberships.some(isStaffMembership);

  if (targetIsStaff && !(await mayActAsStaff(input.realUserId))) {
    return { ok: false, refusal: "needs_capability" };
  }

  const grant = await createActAsGrant({
    sessionId: input.sessionId,
    actorUserId: input.realUserId,
    targetUserId: target.id,
    reason,
    expiresAt: new Date(Date.now() + ACT_AS_GRANT_SECONDS * 1000),
  });

  return {
    ok: true,
    grantId: grant.id,
    targetUserId: target.id,
    expiresAt: grant.expiresAt,
  };
}

/**
 * Stop, and come back to yourself.
 *
 * Every live grant on the session is ended, not merely the newest — a renewal
 * leaves the earlier row live until its own hour runs out, and one of those
 * would keep the access open behind a banner that had just been dismissed.
 */
export async function stopActingAs(sessionId: string): Promise<number> {
  return endActAsGrantsForSession(sessionId);
}
