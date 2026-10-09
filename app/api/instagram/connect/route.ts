import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { appOrigin } from "@/lib/auth/origin";
import { authorizeUrl, instagramConfig } from "@/lib/integrations/instagram";
import { IG_STATE_COOKIE, igStateCookieOptions, newIgState } from "@/lib/integrations/instagram-state";

/**
 * "Connect Instagram": off to Instagram's own sign-in, with a state value
 * kept in this browser for the business that is open. social.connect, which
 * owners and managers hold. Instagram comes back to ./callback.
 */

export const dynamic = "force-dynamic";

const back = (query: string) => NextResponse.redirect(new URL(`/channels/instagram?${query}`, appOrigin()!));

export async function GET(request: Request) {
  const decision = await authorizeRequest(request, "social.connect");
  if (!decision.allowed) return back("error=role");
  const config = instagramConfig();
  if (!config) return back("error=notconfigured");

  const { state, cookie } = newIgState(decision.businessId);
  const response = NextResponse.redirect(authorizeUrl(config, state));
  response.cookies.set(IG_STATE_COOKIE, cookie, igStateCookieOptions());
  return response;
}
