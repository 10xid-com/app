import { NextResponse, type NextRequest } from "next/server";
import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import {
  addressedToApp,
  appHost,
  appOrigin,
  isStateChanging,
  isTrustedOrigin,
} from "@/lib/auth/origin";

/**
 * Proxy — Next.js 16's name for middleware.
 *
 * Four things, in order, none of them authorization:
 *
 *   1. One host. The portal answers on app.10xid.com and nowhere else; a
 *      client domain gets no management cookie (Revision 2, and Paolo's
 *      decision of 2026-10-07 to take the portal off client domains). Any
 *      other Host is refused here, failing closed.
 *   2. The machine endpoint (/api/v1/*) is let through untouched. It carries
 *      an API key, never a cookie, and is called cross-origin by design.
 *   3. A state-changing request whose Origin is not exactly the app's is
 *      refused before it reaches anything — the cheap half of the check the
 *      central authorization function makes again, with the CSRF token.
 *   4. WorkOS AuthKit: refresh the session when the access token is due, and
 *      send somebody with no session to sign in.
 *
 * What a person may DO is decided per request by lib/auth/authorize.ts, in
 * every page, server action and route handler — Next's own guidance is that a
 * proxy must not be the only check, because a matcher change can silently
 * stop it running.
 */

/** Reachable without a WorkOS session. */
const PUBLIC_PATHS = new Set(["/callback", "/sign-in"]);

export default async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const expectedHost = appHost();
  const { pathname } = request.nextUrl;

  // Railway's healthcheck, on whatever host it uses. It reveals nothing.
  if (pathname === "/healthz") return NextResponse.next();

  if (!expectedHost) {
    return new NextResponse("The portal is not configured.", { status: 500 });
  }

  // 1.
  if (host !== expectedHost) {
    return new NextResponse("Not found.", { status: 404 });
  }

  // 2.
  if (pathname.startsWith("/api/v1/")) return NextResponse.next();

  // 3.
  if (
    isStateChanging(request.method) &&
    !isTrustedOrigin(request.headers.get("origin"), appOrigin())
  ) {
    return new NextResponse("Forbidden.", { status: 403 });
  }

  // 4. The SDK is handed the request as the browser addressed it, in both
  // calls: it takes the Secure flag of the session and PKCE cookies it writes
  // from the request URL, which behind Railway's proxy is plain http
  // (see addressedToApp).
  const addressed = addressedToApp(request);
  const { session, headers, authorizationUrl } = await authkit(addressed);

  if (PUBLIC_PATHS.has(pathname) || session.user) {
    return handleAuthkitHeaders(addressed, headers);
  }

  // No session. A page is sent to sign in and brought back; anything else —
  // a fetch, a server action — is refused rather than answered with a page.
  if (request.method === "GET" && authorizationUrl && !pathname.startsWith("/api/")) {
    return handleAuthkitHeaders(addressed, headers, { redirect: authorizationUrl });
  }
  return new NextResponse("Sign in first.", { status: 401 });
}

export const config = {
  matcher: [
    // Everything except Next's own assets and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
