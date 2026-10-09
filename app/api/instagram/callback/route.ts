import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { appOrigin } from "@/lib/auth/origin";
import { connectInstagram, InstagramTakenError } from "@/lib/db/social";
import { exchangeCode, InstagramError, instagramConfig, longLivedToken, profile } from "@/lib/integrations/instagram";
import { IG_STATE_COOKIE, igStateCookieOptions, igStateMatches } from "@/lib/integrations/instagram-state";

/**
 * Instagram's sign-in comes back here (the redirect address registered with
 * Meta). The code is accepted only with the state this browser was given for
 * the business still open, from someone who may connect it. It becomes a
 * 60-day token, the account is read, and the connection is stored with the
 * token sealed.
 *
 * Only professional accounts (Business, Creator) can be posted to; a personal
 * account is turned away with what to do about it.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const jar = await cookies();
  const saved = jar.get(IG_STATE_COOKIE)?.value;

  const back = (query: string) => {
    const response = NextResponse.redirect(new URL(`/channels/instagram?${query}`, appOrigin()!));
    response.cookies.set(IG_STATE_COOKIE, "", igStateCookieOptions(0));
    return response;
  };

  const decision = await authorizeRequest(request, "social.connect");
  if (!decision.allowed) return back("error=role");
  const config = instagramConfig();
  if (!config) return back("error=notconfigured");

  const url = new URL(request.url);
  if (!igStateMatches(saved, url.searchParams.get("state"), decision.businessId)) return back("error=state");
  // The person pressed Cancel on Instagram's screen.
  if (url.searchParams.get("error")) return back("error=cancelled");
  // Instagram appends #_ to the address; a browser keeps fragments to itself,
  // but a pasted address might carry it.
  const code = (url.searchParams.get("code") ?? "").replace(/#_$/, "");
  if (!code) return back("error=cancelled");

  try {
    const short = await exchangeCode(config, code);
    const lasting = await longLivedToken(config, short.token);
    const account = await profile(lasting.token);
    if (account.accountType && !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(account.accountType.toUpperCase())) {
      return back("error=personal");
    }
    await connectInstagram(
      { organizationId: decision.businessId, userId: decision.ctx.userId },
      {
        accountId: account.accountId,
        scopedId: short.scopedId,
        username: account.username,
        token: lasting.token,
        expiresAt: lasting.expiresAt,
        scopes: short.permissions,
        agencyGrantId: decision.via?.grantId ?? null,
      },
    );
    return back("done=connected");
  } catch (err) {
    if (err instanceof InstagramTakenError) return back("error=taken");
    if (err instanceof InstagramError) return back(`error=instagram&detail=${encodeURIComponent(err.message.slice(0, 200))}`);
    throw err;
  }
}
