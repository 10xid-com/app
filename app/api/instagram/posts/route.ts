import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/db/audit";
import { instagramFor, instagramToken, socialMediaFor } from "@/lib/db/social";
import { CAPTION_LIMIT, InstagramError, MAX_PHOTOS, publishMedia } from "@/lib/integrations/instagram";
import { BucketError, presignedGet } from "@/lib/integrations/media-bucket";
import { forgetSocialMedia } from "@/lib/integrations/social-media";
import { CAROUSEL_VIDEO_MAX_MS } from "@/lib/integrations/video-limits";

/**
 * Post to the business's Instagram account: one photo, one video (a Reel),
 * or a carousel of up to ten photos and videos, with a caption. The files are
 * ones this business uploaded (./photos, ./videos), named by id; Instagram is
 * handed a presigned address for each, good for three hours, and they are
 * deleted from the store once the post is made.
 *
 * A video takes Instagram a while to process, so this can take minutes; the
 * composer says so.
 *
 * social.publish (owners, managers, publishers), CSRF and Origin checked by
 * the central function. Recorded on the business's audit record.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const body = z.object({
  caption: z.string().max(CAPTION_LIMIT),
  media: z.array(z.uuid()).min(1).max(MAX_PHOTOS),
  reel: z.object({ shareToFeed: z.boolean(), coverMs: z.number().int().min(0).nullable() }).optional(),
});

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post to Instagram here." }, { status: 403 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Add one to ten photos or videos and a caption of up to 2,200 characters." }, { status: 400 });

  const connection = await instagramFor(owner);
  if (!connection) return NextResponse.json({ error: "Connect Instagram first." }, { status: 409 });
  const files = await socialMediaFor(owner, parsed.data.media);
  if (!files) return NextResponse.json({ error: "A photo or video has expired or did not finish uploading. Add it again." }, { status: 410 });
  if (files.length > 1 && files.some((f) => f.kind === "video" && (f.durationMs ?? 0) > CAROUSEL_VIDEO_MAX_MS)) {
    return NextResponse.json({ error: "A video in a carousel can be up to a minute long. Post a longer one on its own, as a Reel." }, { status: 400 });
  }

  try {
    const token = await instagramToken(owner, connection);
    const items = await Promise.all(files.map(async (f) => ({ kind: f.kind, url: await presignedGet(f.storageKey, 3 * 60 * 60) })));
    const reel = files.length === 1 && files[0].kind === "video" ? (parsed.data.reel ?? { shareToFeed: true, coverMs: null }) : undefined;
    if (reel && reel.coverMs !== null && reel.coverMs > (files[0].durationMs ?? 0)) reel.coverMs = null;
    const posted = await publishMedia(token, connection.accountId, { caption: parsed.data.caption, items, reel });
    await forgetSocialMedia(owner, files.map((f) => f.id));
    await recordAudit([
      {
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        agencyGrantId: decision.via?.grantId ?? null,
        action: reel ? "instagram.posted_reel" : "instagram.posted",
        target: posted.permalink ?? posted.id,
      },
    ]);
    return NextResponse.json({ id: posted.id, permalink: posted.permalink });
  } catch (err) {
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    if (!(err instanceof InstagramError)) throw err;
    return NextResponse.json(
      { error: err.signedOut ? "Instagram has signed this connection out. Connect it again." : err.message, signedOut: err.signedOut },
      { status: 502 },
    );
  }
}
