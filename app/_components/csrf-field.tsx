import { withAuth } from "@workos-inc/authkit-nextjs";
import { CSRF_FIELD, csrfSecret, csrfTokenFor } from "@/lib/auth/csrf";

/**
 * The CSRF token, as a hidden field. Every form that posts to a server action
 * carries one; the central authorization function refuses the action without
 * it (lib/auth/authorize.ts, step 3).
 *
 * Rendered on the server from the WorkOS session id, so it never needs
 * storing and dies with the session.
 */
export async function CsrfField() {
  const { sessionId } = await withAuth();
  const secret = csrfSecret();
  if (!sessionId || !secret) return null;
  return <input type="hidden" name={CSRF_FIELD} value={csrfTokenFor(sessionId, secret)} />;
}
