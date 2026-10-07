"use server";

import { signOut } from "@workos-inc/authkit-nextjs";
import { requireSameOriginRequest } from "@/lib/auth/authorize";

/**
 * Sign out: the app's cookie AND the WorkOS session (Revision 2).
 *
 * signOut() deletes the host-only session cookie here, then sends the browser
 * to WorkOS's logout address for this session id, which ends the provider
 * session too, before WorkOS returns it to the sign-out URI set in the
 * dashboard.
 */
export async function signOutAction(formData: FormData) {
  await requireSameOriginRequest(formData);
  await signOut();
}
