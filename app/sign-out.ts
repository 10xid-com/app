"use server";

import { redirect } from "next/navigation";
import { getSessionContext, signOutEverywhere } from "@/lib/auth/session";
import { signInUrl } from "@/lib/auth/sso";

/**
 * Sign out, everywhere.
 *
 * Ends the session on this host and every other session the person holds, on
 * every domain, the login host's included — a cookie on another domain cannot
 * be reached from here, but every row it points at is revoked. Then on to the
 * login host's sign-in form, by full address: this app has none of its own.
 */
export async function signOutAction() {
  const ctx = await getSessionContext();
  if (ctx) {
    /**
     * realUserId, not userId.
     *
     * Signing out ends every session the person at the keyboard holds. While
     * acting as somebody else, `userId` is THEIR account — so the unchanged
     * line would have signed the target out of every device they own, on every
     * domain, because somebody else pressed a button in a window wearing their
     * name. The act-as grant lives on this session and dies with it either way.
     */
    await signOutEverywhere(ctx.realUserId, ctx.sessionId);
  }
  redirect(signInUrl());
}
