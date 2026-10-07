import { CSRF_FIELD } from "@/lib/auth/csrf";
import { resolveIdentity } from "@/lib/auth/session";

/**
 * The CSRF token, as a hidden field. Every form that posts to a server action
 * carries one; the central authorization function refuses the action without
 * it (lib/auth/authorize.ts, step 3).
 */
export async function CsrfField() {
  const identity = await resolveIdentity();
  if (identity.state !== "active") return null;
  return <input type="hidden" name={CSRF_FIELD} value={identity.csrfToken} />;
}
