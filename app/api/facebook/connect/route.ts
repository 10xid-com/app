import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { appOrigin } from "@/lib/auth/origin";
import { mediaBucketConfigured } from "@/lib/integrations/media-bucket";
import { authorizeUrl, facebookConfig } from "@/lib/integrations/facebook";
import { newOAuthState, oauthCookieOptions, stateCookieName } from "@/lib/integrations/oauth-state";

/**
 * "Connect Facebook": off to Facebook Login, with a state value kept in this
 * browser for the business that is open. social.connect, which owners and
 * managers hold. Facebook comes back to ./callback.
 */

export const dynamic = "force-dynamic";

const back = (query: string) => NextResponse.redirect(new URL(`/channels/facebook?${query}`, appOrigin()!));

export async function GET(request: Request) {
  const decision = await authorizeRequest(request, "social.connect");
  if (!decision.allowed) return back("error=role");
  const config = facebookConfig();
  if (!config || !mediaBucketConfigured()) return back("error=notconfigured");

  const { state, cookie } = newOAuthState(decision.businessId);
  const response = NextResponse.redirect(authorizeUrl(config, state));
  response.cookies.set(stateCookieName("facebook"), cookie, oauthCookieOptions());
  return response;
}
