import { NextResponse, type NextRequest } from "next/server";
import { appHost, appOrigin, isStateChanging, isTrustedOrigin } from "@/lib/auth/origin";

/**
 * Proxy — Next.js 16's name for middleware.
 *
 * Routing and cheap refusals, none of them authorization:
 *
 *   1. The healthcheck answers on any host (Railway's checker does not send
 *      app.10xid.com) and says nothing but "ok".
 *   2. One host. The portal answers on PORTAL_HOST and nowhere else; any other
 *      Host is refused, failing closed.
 *   3. The machine endpoint (/api/v1/*) is let through untouched. It carries
 *      an API key, never a cookie, and is called cross-origin by design.
 *   4. A state-changing request whose Origin is not exactly the app's is
 *      refused before it reaches anything — the cheap half of the check the
 *      central authorization function makes again, with the CSRF token.
 *   5. No session cookie at all: a page goes into the handoff to the login
 *      host and comes back; anything else is refused rather than answered
 *      with a page.
 *
 * A cookie being PRESENT is all that is checked here. Whether it is valid —
 * and whether the sign-in behind it still is — is decided per request by
 * lib/auth/session.ts and lib/auth/authorize.ts.
 */

const SESSION_COOKIES = ["__Host-portal_session", "portal_session"];

export default async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const expectedHost = appHost();
  const { pathname, search } = request.nextUrl;

  // 1.
  if (pathname === "/healthz") return NextResponse.next();

  if (!expectedHost) {
    return new NextResponse("The portal is not configured.", { status: 500 });
  }

  // 2.
  if (host !== expectedHost) {
    return new NextResponse("Not found.", { status: 404 });
  }

  // 3.
  if (pathname.startsWith("/api/v1/")) return NextResponse.next();

  // 4.
  if (isStateChanging(request.method) && !isTrustedOrigin(request.headers.get("origin"), appOrigin())) {
    return new NextResponse("Forbidden.", { status: 403 });
  }

  // The handoff itself is how a session is made.
  if (pathname.startsWith("/auth/sso/")) return NextResponse.next();

  // 5.
  if (SESSION_COOKIES.some((name) => request.cookies.has(name))) return NextResponse.next();
  if (request.method === "GET" && !pathname.startsWith("/api/")) {
    const start = new URL("/auth/sso/start", appOrigin()!);
    start.searchParams.set("path", `${pathname}${search}`);
    return NextResponse.redirect(start);
  }
  return new NextResponse("Sign in first.", { status: 401 });
}

export const config = {
  matcher: [
    // Everything except Next's own assets and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
