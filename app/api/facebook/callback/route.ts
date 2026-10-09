import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { appOrigin } from "@/lib/auth/origin";
import { connectSocial, SocialAccountTakenError } from "@/lib/db/social";
import { facebookConfig, FacebookError, managedPages, personToken, whoSignedIn } from "@/lib/integrations/facebook";
import { FB_PENDING_COOKIE, pendingCookieOptions, sealPending } from "@/lib/integrations/facebook-pending";
import { oauthCookieOptions, oauthStateMatches, stateCookieName } from "@/lib/integrations/oauth-state";

/**
 * Facebook Login comes back here (the redirect address registered with
 * Meta). The code is accepted only with the state this browser was given for
 * the business still open, from someone who may connect it. It becomes a
 * long-lived token for the person, and the Pages they manage are read:
 *
 *   one Page they can post to     it is connected, with its own token
 *   several                       they choose (/channels/facebook?choose=1),
 *                                 their token waiting sealed in their cookie
 *   none                          they are told what is missing
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const jar = await cookies();
  const saved = jar.get(stateCookieName("facebook"))?.value;

  const back = (query: string, pending?: string) => {
    const response = NextResponse.redirect(new URL(`/channels/facebook?${query}`, appOrigin()!));
    response.cookies.set(stateCookieName("facebook"), "", oauthCookieOptions(0));
    if (pending) response.cookies.set(FB_PENDING_COOKIE, pending, pendingCookieOptions());
    return response;
  };

  const decision = await authorizeRequest(request, "social.connect");
  if (!decision.allowed) return back("error=role");
  const config = facebookConfig();
  if (!config) return back("error=notconfigured");

  const url = new URL(request.url);
  if (!oauthStateMatches(saved, url.searchParams.get("state"), decision.businessId)) return back("error=state");
  if (url.searchParams.get("error")) return back("error=cancelled");
  const code = url.searchParams.get("code") ?? "";
  if (!code) return back("error=cancelled");

  try {
    const token = await personToken(config, code);
    const person = await whoSignedIn(token);
    if (!person.granted.includes("pages_manage_posts") || !person.granted.includes("pages_show_list")) return back("error=permissions");
    const pages = (await managedPages(token)).filter((p) => p.canPost);
    if (pages.length === 0) return back("error=nopages");
    if (pages.length > 1) return back("choose=1", sealPending(decision.businessId, person.id, token));

    const [page] = pages;
    await connectSocial(
      { organizationId: decision.businessId, userId: decision.ctx.userId },
      "facebook",
      {
        accountId: page.id,
        scopedId: person.id,
        username: page.name,
        token: page.token,
        expiresAt: null,
        scopes: person.granted,
        agencyGrantId: decision.via?.grantId ?? null,
      },
    );
    return back("done=connected");
  } catch (err) {
    if (err instanceof SocialAccountTakenError) return back("error=taken");
    if (err instanceof FacebookError) return back(`error=facebook&detail=${encodeURIComponent(err.message.slice(0, 200))}`);
    throw err;
  }
}
