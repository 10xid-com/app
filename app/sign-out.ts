"use server";

import { redirect } from "next/navigation";
import { requireSameOriginRequest } from "@/lib/auth/authorize";
import { clearSessionCookie, resolveIdentity } from "@/lib/auth/session";
import { revokeAllSessionsForUser, revokeSession } from "@/lib/db/identity";

/** Sign out: this session, whether it was past the authenticator or still pending. */
export async function signOutAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  const identity = await resolveIdentity();
  if (identity.state !== "signed_out") await revokeSession(identity.sessionId);
  await clearSessionCookie();
  redirect("/auth/sign-in?notice=signed-out");
}

/** Sign out on every device: every portal session of this account. */
export async function signOutEverywhereAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  const identity = await resolveIdentity();
  if (identity.state === "active") await revokeAllSessionsForUser(identity.ctx.userId);
  await clearSessionCookie();
  redirect("/auth/sign-in?notice=signed-out-everywhere");
}
