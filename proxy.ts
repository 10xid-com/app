import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy — renamed from Middleware in Next.js 16, same job.
 *
 * This app is the portal. It never signs anybody in: that happens on the login
 * host (PRIMARY_HOST, served by 10xid-com/login), and this app receives its
 * session by the cross-domain handoff, exactly as a client domain does. So:
 *
 *   - a request with no session cookie at all is sent into the handoff instead
 *     of rendering a signed-out page;
 *   - any other /auth/ page — a link to /auth/login, say — is the login host's,
 *     and is sent there.
 *
 * It deliberately does not validate the session. Next's own guidance is that
 * this layer is for optimistic checks and must not be a session-management or
 * authorisation solution — it runs before routes, without the database, and a
 * check here would be a check in the wrong place. Real enforcement happens in
 * the data access layer, with Postgres enforcing the same rule underneath, so a
 * forged or stale cookie gets past this and then gets nothing.
 *
 * In other words: this is a convenience that saves a redirect, not a gate.
 */

const SESSION_COOKIES = ["__Host-portal_session", "portal_session"];

/** The receiving end of the handoff: the only /auth/ routes this app has. */
const HANDOFF = "/auth/sso/";

/** The same rule as originFor() in lib/auth/sso, which is server-only. */
function originFor(host: string): string {
  const secure = process.env.SESSION_COOKIE_SECURE !== "false";
  return `${secure ? "https" : "http"}://${host}`;
}

export function proxy(request: NextRequest) {
  const primary = (process.env.PRIMARY_HOST ?? "").toLowerCase();
  const { pathname, search } = request.nextUrl;

  // Never interfere with the machine endpoints. They carry an API key rather
  // than a cookie, and redirecting one would answer a POST with a 307 to an
  // HTML page — which a caller reads as "it worked, sort of", and which is a
  // far more confusing failure than a plain 401.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  // Nor with the handoff itself — doing so is how you build a redirect loop.
  if (pathname.startsWith(HANDOFF)) return NextResponse.next();

  // Every other /auth/ page lives on the login host.
  if (pathname.startsWith("/auth/") && primary) {
    return NextResponse.redirect(
      new URL(`${pathname}${search}`, originFor(primary)),
    );
  }

  // A cookie being PRESENT is all that is checked. Whether it is valid is the
  // application's business, not this layer's.
  if (SESSION_COOKIES.some((name) => request.cookies.has(name))) {
    return NextResponse.next();
  }

  const start = request.nextUrl.clone();
  start.pathname = "/auth/sso/start";
  start.search = "";
  start.searchParams.set("path", `${pathname}${search}`);
  return NextResponse.redirect(start);
}

export const config = {
  matcher: [
    // Everything except Next's own assets and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
