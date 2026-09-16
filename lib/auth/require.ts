import "server-only";
import { redirect } from "next/navigation";
import { currentHost, getSessionContext, type SessionContext } from "./session";
import { isPrimaryHost } from "./sso";

/**
 * Every signed-in page starts here.
 *
 * Where an unauthenticated visitor is sent depends on which domain they are on:
 * the login host shows the sign-in form, and a client domain restarts the
 * cross-domain handoff, because sign-in happens on the login host and nowhere
 * else. A client domain showing its own sign-in form would be a second place to
 * authenticate, which is exactly what this design avoids.
 */
export async function requireSession(
  returnPath = "/",
): Promise<SessionContext> {
  const ctx = await getSessionContext();

  if (ctx) {
    // Staff have proved they hold the inbox and nothing more. A staff session
    // reaches every client's data, and an inbox is the thing most likely to be
    // compromised — it is where password resets for everything else arrive.
    if (ctx.needsSecondFactor) {
      redirect(`/auth/2fa?next=${encodeURIComponent(returnPath)}`);
    }
    return ctx;
  }

  const host = await currentHost();
  if (isPrimaryHost(host)) {
    redirect(`/auth/login?next=${encodeURIComponent(returnPath)}`);
  }
  redirect(`/auth/sso/start?path=${encodeURIComponent(returnPath)}`);
}
