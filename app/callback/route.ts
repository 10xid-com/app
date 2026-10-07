import { handleAuth } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";
import { resolveSignIn } from "@/lib/auth/sign-in";
import { addressedToApp, appOrigin } from "@/lib/auth/origin";

/**
 * The one WorkOS callback: https://app.10xid.com/callback.
 *
 * The SDK verifies PKCE and the sealed state against its verifier cookie,
 * exchanges the code, and writes the session cookie — host-only, because
 * WORKOS_COOKIE_DOMAIN is left unset. onSuccess is where the WorkOS user is
 * tied to a local account, the only write a sign-in causes
 * (lib/auth/sign-in.ts). Whatever the outcome, the person lands on the page
 * they asked for, and the central authorization function decides from there:
 * someone not yet bound is shown the access page.
 *
 * Railway runs the server behind a proxy, where the request URL is the address
 * the process is bound to rather than https://app.10xid.com. `baseURL` fixes
 * where the person is sent afterwards; addressedToApp fixes the URL the SDK
 * reads the cookie's Secure flag from, which would otherwise be http.
 */
const handler = handleAuth({
  baseURL: appOrigin() ?? undefined,
  onSuccess: async ({ user }) => {
    const outcome = await resolveSignIn({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
    });
    console.info(`[sign-in] ${user.id} ${outcome}`);
  },
});

export function GET(request: NextRequest) {
  return handler(addressedToApp(request));
}
