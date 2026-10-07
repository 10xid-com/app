import "server-only";
import { redirect } from "next/navigation";
import type { SessionContext } from "./session";

/**
 * Kept for the staff and act-as screens, which are turned off rather than
 * deleted. There is no acting as anybody (`actingAs` is always
 * null), so this never redirects; it stays so those files keep their guard if
 * the feature is ever rebuilt on agency grants.
 *
 * Everything that used to live here — requireSession() and the handoff — is
 * now the central authorization function: lib/auth/authorize.ts.
 */
export function refuseWhileActingAs(ctx: SessionContext): void {
  if (ctx.actingAs) redirect("/act-as?error=blocked");
}
