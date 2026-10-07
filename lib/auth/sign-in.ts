import "server-only";
import { findUserByEmail } from "@/lib/db/identity";
import { acceptInvitation, liveInvitationFor } from "@/lib/db/invitations";
import { requestBinding, userByWorkosId } from "@/lib/db/workos";

/**
 * What a WorkOS sign-in means locally, worked out once, at the callback.
 *
 * WorkOS has just told us who this is. This decides which local account that
 * is — and it is the only place that writes anything because of a sign-in.
 * It runs inside the callback, the one GET that exists to establish identity
 * (PKCE and state verified by the SDK); no page render ever writes.
 *
 *   bound                 the WorkOS user id already names an account.
 *   invitation_accepted   no account yet, and a live invitation is made out to
 *                         exactly this verified address: the account is
 *                         created, bound, with that invitation's business and
 *                         role (Revision 2's exact-email invitation rule).
 *   binding_requested     an account from before WorkOS holds this verified
 *                         address. It is NOT bound here: an operator confirms
 *                         first (Paolo's decision, 2026-10-07), because an
 *                         address match alone never grants access.
 *   conflict              that account is already bound to a different WorkOS
 *                         user. Nothing happens; it needs a person to look.
 *   unverified            WorkOS has not verified the address, so it is not
 *                         evidence of anything.
 *   no_access             none of the above.
 */

export type SignInOutcome =
  | "bound"
  | "invitation_accepted"
  | "binding_requested"
  | "conflict"
  | "unverified"
  | "no_access";

export type WorkosIdentity = {
  id: string;
  email: string;
  emailVerified: boolean;
};

/** Revision 2's "normalized", as the brief recommends: trimmed and lowercased, nothing more. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function resolveSignIn(user: WorkosIdentity): Promise<SignInOutcome> {
  if (await userByWorkosId(user.id)) return "bound";
  if (!user.emailVerified) return "unverified";

  const email = normalizeEmail(user.email);

  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.isService) return "no_access";
    if (existing.workosUserId) return "conflict";
    await requestBinding({ userId: existing.id, workosUserId: user.id, email });
    return "binding_requested";
  }

  const invitation = await liveInvitationFor(email);
  if (invitation) {
    const accepted = await acceptInvitation({
      invitationId: invitation.id,
      organizationId: invitation.organizationId,
      email,
      role: invitation.role,
      workosUserId: user.id,
    });
    return accepted ? "invitation_accepted" : "no_access";
  }

  return "no_access";
}
