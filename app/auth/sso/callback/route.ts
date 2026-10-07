import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { redeemTicket } from "@/lib/db/identity";
import { touchAuthSession } from "@/lib/db/auth-session";
import { startSession, writeSessionCookie } from "@/lib/auth/session";
import { appHost, appOrigin } from "@/lib/auth/origin";
import { SSO_STATE_COOKIE, decodeState, hashTicket, stateCookieOptions, statesMatch } from "@/lib/auth/sso";

/**
 * Step 3, on the portal: redeem the ticket for a first-party session.
 *
 *   the state cookie   proves this browser started the flow (login CSRF);
 *   the ticket         proves the login host vouched for this person, for THIS
 *                      host, within the last 30 seconds, once — spent by one
 *                      atomic update, so two racing attempts have one winner;
 *   the sign-in        it names must still be live and past the authenticator,
 *                      and its hard end becomes this session's.
 *
 * Every failure looks the same (/auth/sso/failed).
 */
export async function GET(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const self = appOrigin();
  if (!self || host !== appHost()) return new NextResponse("Not found.", { status: 404 });

  const jar = await cookies();
  const expected = decodeState(jar.get(SSO_STATE_COOKIE)?.value);
  const returned = request.nextUrl.searchParams.get("state") ?? "";
  const ticket = request.nextUrl.searchParams.get("ticket") ?? "";
  jar.set(SSO_STATE_COOKIE, "", stateCookieOptions(0));

  const fail = () => {
    const response = NextResponse.redirect(new URL("/auth/sso/failed", self), 303);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  if (!expected || !ticket || !statesMatch(expected.state, returned)) return fail();

  const redeemed = await redeemTicket(hashTicket(ticket), host);
  if (!redeemed?.sourceAuthSessionId) return fail();

  const hardEnd = await touchAuthSession(redeemed.sourceAuthSessionId);
  if (!hardEnd) return fail();

  const { token } = await startSession({
    userId: redeemed.userId,
    host,
    authSessionId: redeemed.sourceAuthSessionId,
    hardEnd,
  });
  await writeSessionCookie(token, hardEnd);

  // 303 so the spent ticket leaves the address bar rather than sitting in
  // history to be re-sent on a refresh.
  const response = NextResponse.redirect(new URL(expected.path, self), 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
