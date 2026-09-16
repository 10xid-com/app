import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy — renamed from Middleware in Next.js 16, same job.
 *
 * This does ONE cheap thing: if a request arrives at a client domain with no
 * session cookie at all, send it into the cross-domain handoff instead of
 * rendering a signed-out page.
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

export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const primary = (process.env.PRIMARY_HOST ?? "").toLowerCase();
  const { pathname, search } = request.nextUrl;

  // Never interfere with the sign-in plumbing itself — doing so is how you
  // build a redirect loop that only shows up on the one domain you did not test.
  if (pathname.startsWith("/auth/")) return NextResponse.next();

  // A cookie being PRESENT is all that is checked. Whether it is valid is the
  // application's business, not this layer's.
  if (SESSION_COOKIES.some((name) => request.cookies.has(name))) {
    return NextResponse.next();
  }

  // On the login host, an unauthenticated visit is an ordinary sign-in.
  if (!primary || host === primary) return NextResponse.next();

  // On a client domain, it is the first step of the handoff.
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
