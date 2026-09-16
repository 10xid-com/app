import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { domainByHostname } from "@/lib/db/identity";
import { secretToken } from "@/lib/ids";
import {
  PRIMARY_HOST,
  SSO_STATE_COOKIE,
  SSO_STATE_TTL_SECONDS,
  encodeState,
  isPrimaryHost,
  originFor,
  safePath,
} from "@/lib/auth/sso";

/**
 * Step 1, on a client domain: begin the handoff.
 *
 * Note what is NOT sent to the login host: the return path. It is kept in this
 * site's own cookie, so where the person lands afterwards is decided entirely
 * here and cannot be influenced by anything that made the round trip. The login
 * host only ever learns which site asked and an opaque state value to echo back.
 */
export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();

  if (!PRIMARY_HOST) {
    return new NextResponse("PRIMARY_HOST is not configured.", { status: 500 });
  }

  // The login host signs people in directly; it never hands off to itself.
  if (isPrimaryHost(host)) {
    return NextResponse.redirect(new URL("/auth/login", originFor(host)));
  }

  // A host that is not a registered client domain takes no part in this at all.
  const domain = await domainByHostname(host);
  if (!domain) {
    return new NextResponse("This hostname is not a registered client domain.", {
      status: 404,
    });
  }

  const state = secretToken(24);
  const path = safePath(request.nextUrl.searchParams.get("path"));

  const jar = await cookies();
  jar.set(SSO_STATE_COOKIE, encodeState({ state, path }), {
    httpOnly: true,
    // Lax is required here, not merely acceptable: the browser comes BACK to
    // this site by a top-level GET redirect from another domain, and Lax is
    // exactly the setting that allows a cookie on that navigation while still
    // withholding it from cross-site POSTs and embedded requests.
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE !== "false",
    path: "/",
    maxAge: SSO_STATE_TTL_SECONDS,
  });

  const authorize = new URL("/auth/sso/authorize", originFor(PRIMARY_HOST));
  authorize.searchParams.set("site", domain.id);
  authorize.searchParams.set("state", state);

  return NextResponse.redirect(authorize);
}
