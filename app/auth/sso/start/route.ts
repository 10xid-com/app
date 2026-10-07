import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { domainByHostname } from "@/lib/db/identity";
import { secretToken } from "@/lib/ids";
import { appHost, appOrigin, loginOrigin } from "@/lib/auth/origin";
import { safePath } from "@/lib/auth/paths";
import { SSO_STATE_COOKIE, SSO_STATE_TTL_SECONDS, encodeState, stateCookieOptions } from "@/lib/auth/sso";

/**
 * Step 1, on the portal: begin the handoff to the login host.
 *
 * What is NOT sent: the return path. It stays in this site's own cookie, so
 * where the person lands afterwards is decided here and cannot be influenced
 * by anything that made the round trip. The login host learns only which site
 * asked (an id from the registered-domains table) and an opaque state to echo.
 */
export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const self = appOrigin();
  const login = loginOrigin();
  if (!self || !login || host !== appHost()) {
    return new NextResponse("Not found.", { status: 404 });
  }

  const domain = await domainByHostname(host);
  if (!domain) {
    return new NextResponse("The portal host is not registered.", { status: 500 });
  }

  const state = secretToken(24);
  const path = safePath(request.nextUrl.searchParams.get("path"));
  (await cookies()).set(SSO_STATE_COOKIE, encodeState({ state, path }), stateCookieOptions(SSO_STATE_TTL_SECONDS));

  const authorize = new URL("/auth/sso/authorize", login);
  authorize.searchParams.set("site", domain.id);
  authorize.searchParams.set("state", state);
  const response = NextResponse.redirect(authorize);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
