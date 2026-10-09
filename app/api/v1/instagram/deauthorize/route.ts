import { NextResponse } from "next/server";
import { revokeInstagram } from "@/lib/db/social";
import { instagramConfig, verifySignedRequest } from "@/lib/integrations/instagram";

/**
 * Meta's "Deauthorize callback": someone removed the app from their Instagram
 * account. The notice is signed with the app secret and checked before
 * anything happens; then every connection to that account is ended and its
 * token erased, on the record of each business it belonged to.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = instagramConfig();
  if (!config) return new NextResponse("Not found.", { status: 404 });
  const form = await request.formData().catch(() => null);
  const signed = form?.get("signed_request");
  const who = typeof signed === "string" ? verifySignedRequest(config, signed) : null;
  if (!who) return NextResponse.json({ error: "Bad signed_request." }, { status: 400 });
  await revokeInstagram(who, "deauthorize");
  return NextResponse.json({ ok: true });
}
