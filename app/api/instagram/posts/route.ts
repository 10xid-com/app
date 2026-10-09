import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { appOrigin } from "@/lib/auth/origin";
import { recordAudit } from "@/lib/db/audit";
import { deleteSocialPhotos, instagramFor, instagramToken, socialPhotosFor } from "@/lib/db/social";
import { CAPTION_LIMIT, InstagramError, MAX_PHOTOS, publishPhotos } from "@/lib/integrations/instagram";

/**
 * Post to the business's Instagram account: one photo, or a carousel of up to
 * ten, with a caption. The photos are ones this business uploaded through
 * ./photos, named by their tokens; Instagram fetches each from its public
 * address (/api/v1/instagram/photos/<token>.jpg) while the post is made, and
 * they are deleted once it is.
 *
 * social.publish (owners, managers, publishers), CSRF and Origin checked by
 * the central function. Recorded on the business's audit record.
 */

export const dynamic = "force-dynamic";

const body = z.object({
  caption: z.string().max(CAPTION_LIMIT),
  photos: z.array(z.string().regex(/^[A-Za-z0-9_-]{43}$/)).min(1).max(MAX_PHOTOS),
});

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post to Instagram here." }, { status: 403 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Add one to ten photos and a caption of up to 2,200 characters." }, { status: 400 });

  const connection = await instagramFor(owner);
  if (!connection) return NextResponse.json({ error: "Connect Instagram first." }, { status: 409 });
  const photos = await socialPhotosFor(owner, parsed.data.photos);
  if (!photos) return NextResponse.json({ error: "A photo has expired. Add it again." }, { status: 410 });

  try {
    const token = await instagramToken(owner, connection);
    const posted = await publishPhotos(token, connection.accountId, {
      caption: parsed.data.caption,
      imageUrls: photos.map((p) => `${appOrigin()}/api/v1/instagram/photos/${p.token}.jpg`),
    });
    await deleteSocialPhotos(owner, photos.map((p) => p.id));
    await recordAudit([
      {
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        agencyGrantId: decision.via?.grantId ?? null,
        action: "instagram.posted",
        target: posted.permalink ?? posted.id,
      },
    ]);
    return NextResponse.json({ id: posted.id, permalink: posted.permalink });
  } catch (err) {
    if (!(err instanceof InstagramError)) throw err;
    return NextResponse.json(
      { error: err.signedOut ? "Instagram has signed this connection out. Connect it again." : err.message, signedOut: err.signedOut },
      { status: 502 },
    );
  }
}
