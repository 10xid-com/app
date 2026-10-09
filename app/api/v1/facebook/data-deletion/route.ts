import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { appOrigin } from "@/lib/auth/origin";
import { revokeSocial } from "@/lib/db/social";
import { facebookConfig } from "@/lib/integrations/facebook";
import { verifySignedRequest } from "@/lib/integrations/meta";

/**
 * Meta's "Data deletion request" callback. What the portal holds from
 * Facebook about a person is the connection: their app-scoped id, the Page
 * and the access token. The token is erased and the connection ended at once,
 * as for a deauthorize; the business's own record keeps that it happened.
 * Meta expects an address where the request's status can be read, and a
 * confirmation code; GET with that code answers it.
 */

export const dynamic = "force-dynamic";

const codeFor = (who: string) => createHash("sha256").update(`fb-deletion:${who}`).digest("hex").slice(0, 16);

export async function POST(request: Request) {
  const config = facebookConfig();
  if (!config) return new NextResponse("Not found.", { status: 404 });
  const form = await request.formData().catch(() => null);
  const signed = form?.get("signed_request");
  const who = typeof signed === "string" ? verifySignedRequest(config.appSecret, signed) : null;
  if (!who) return NextResponse.json({ error: "Bad signed_request." }, { status: 400 });
  await revokeSocial("facebook", who, "deletion_request");
  const code = codeFor(who);
  return NextResponse.json({ url: `${appOrigin()}/api/v1/facebook/data-deletion?code=${code}`, confirmation_code: code });
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  if (!/^[0-9a-f]{16}$/.test(code)) return new NextResponse("Not found.", { status: 404 });
  return new NextResponse(
    `Deletion request ${code}: done. The Facebook Page connection and its access token have been deleted from 10XiD.`,
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
