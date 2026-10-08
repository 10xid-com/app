"use server";

import { redirect } from "next/navigation";
import { requireSameOriginRequest } from "@/lib/auth/authorize";
import { clearSessionCookie, resolveIdentity } from "@/lib/auth/session";
import { loginOrigin } from "@/lib/auth/origin";
import { revokeAllSessionsForUser, revokeSession } from "@/lib/db/identity";
import { revokeAuthSession, revokeAuthUserSessions } from "@/lib/db/auth-session";

/**
 * Sign out: this portal session AND the sign-in on the login host it came
 * from. Ending only the portal's would leave the login host's, and the next
 * page would hand the browser straight back in.
 */
export async function signOutAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  const identity = await resolveIdentity();
  if (identity.state === "active") {
    await revokeSession(identity.ctx.sessionId);
    await revokeAuthSession(identity.ctx.authSessionId);
  }
  await clearSessionCookie();
  redirect(`${loginOrigin() ?? ""}/auth/sign-in?notice=signed-out`);
}

/**
 * Sign out on every device: every sign-in of this identity on the login host,
 * and every portal session of this account.
 */
export async function signOutEverywhereAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  const identity = await resolveIdentity();
  if (identity.state === "active") {
    await revokeAuthUserSessions(identity.ctx.authUserId);
    // The REAL person, never one being acted as (there is no acting as
    // anybody now, but this is where it would matter).
    await revokeAllSessionsForUser(identity.ctx.userId);
  }
  await clearSessionCookie();
  redirect(`${loginOrigin() ?? ""}/auth/sign-in?notice=signed-out-everywhere`);
}
