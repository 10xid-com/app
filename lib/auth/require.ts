import "server-only";
import { redirect } from "next/navigation";
import { getSessionContext, type SessionContext } from "./session";

/**
 * Every signed-in page starts here.
 *
 * This app signs nobody in: sign-in happens on the login host (10xid-com/login)
 * and nowhere else, and a session arrives here by the cross-domain handoff. So
 * whatever is missing, the answer is to go through the handoff again.
 */
export async function requireSession(
  returnPath = "/",
): Promise<SessionContext> {
  const ctx = await getSessionContext();

  // A staff session that has proved the inbox and nothing more carries no
  // authority (see getSessionContext). The login host finishes the second step
  // before it hands a session over, so one should not reach here; if one does,
  // the handoff is how it gets finished, on the login host.
  if (ctx && !ctx.needsSecondFactor) return ctx;

  redirect(handoffPath(returnPath));
}

/** Back through the handoff, landing on `returnPath` afterwards. */
export function handoffPath(returnPath = "/"): string {
  return `/auth/sso/start?path=${encodeURIComponent(returnPath)}`;
}

/**
 * PROPERTY 1: NO PERMANENT TAKEOVER.
 *
 * Acting as somebody lets you see what they see and do their work. It must
 * never let you walk away owning their account — so for the duration, the
 * handful of things that would survive the grant are refused:
 *
 *   * changing their address, which moves where every future sign-in code is
 *     delivered and therefore moves the account;
 *   * enrolling an authenticator, which is the second factor itself;
 *   * reading their recovery codes, which are the way round the second factor;
 *   * ending their other sessions, which is their account's own business.
 *
 * Every one of those is a thing that still has effect after the hour is up.
 * Everything a grant is actually FOR — reading their jobs, filing one, moving
 * one along — stops the moment it lapses, and those are left alone.
 *
 * The guard is HERE, in one exported function, rather than being an `if` in
 * each route, because a rule copied into five files is a rule that is in four
 * of them a year from now. test/act-as.test.ts enumerates the account-security
 * surface from disk and fails if a file in it does not call one of these two,
 * so a sixth route added later is caught by the suite rather than by an
 * incident.
 *
 * Note what this does NOT try to be: a defence against the real actor, who is
 * staff and could reach the same rows through the database. It is a defence
 * against the grant OUTLIVING itself. Staff power is bounded by the fact that
 * it is staff power, logged and revocable; what must not exist is a path from
 * "I was you for an hour" to "I am you from now on".
 */
export async function requireOwnAccount(
  returnPath = "/",
): Promise<SessionContext> {
  const ctx = await requireSession(returnPath);
  refuseWhileActingAs(ctx);
  return ctx;
}

/**
 * The same refusal, for the routes that cannot use requireSession().
 *
 * The second-factor screens resolve their own session deliberately — going
 * through requireSession() there would redirect a session that needs a second
 * factor to the page that collects it, which is the page itself. They still
 * have to refuse an act-as session, so they call this directly.
 *
 * Redirects to /act-as rather than to /jobs: somebody who tried to open their
 * authenticator settings while being somebody else needs to be told that is
 * why, and offered the way back. /act-as is reachable in both states.
 */
export function refuseWhileActingAs(ctx: SessionContext): void {
  if (ctx.actingAs) redirect("/act-as?error=blocked");
}
