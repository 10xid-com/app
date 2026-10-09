import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/db/audit";
import { channelToken, socialConnectionFor, socialMediaFor } from "@/lib/db/social";
import { MAX_PHOTOS, MESSAGE_LIMIT, publishToPage } from "@/lib/integrations/facebook";
import { BucketError, presignedGet } from "@/lib/integrations/media-bucket";
import { MetaError } from "@/lib/integrations/meta";
import { forgetSocialMedia } from "@/lib/integrations/social-media";

/**
 * Post to the business's Facebook Page: text on its own, text with up to ten
 * photos, or text with one video. The files are ones this business uploaded
 * (/api/social/photos, /api/social/videos), named by id; Facebook is handed a
 * presigned address for each, good for three hours, and they are deleted from
 * the store once the post is made.
 *
 * social.publish (owners, managers, publishers), CSRF and Origin checked by
 * the central function. Recorded on the business's audit record.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({
  caption: z.string().max(MESSAGE_LIMIT),
  media: z.array(z.uuid()).max(MAX_PHOTOS),
});

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post to Facebook here." }, { status: 403 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (parsed.data.media.length === 0 && !parsed.data.caption.trim())) {
    return NextResponse.json({ error: "Write something, or add photos or a video." }, { status: 400 });
  }

  const connection = await socialConnectionFor(owner, "facebook");
  if (!connection) return NextResponse.json({ error: "Connect Facebook first." }, { status: 409 });
  const files = parsed.data.media.length ? await socialMediaFor(owner, parsed.data.media) : [];
  if (!files) return NextResponse.json({ error: "A photo or video has expired or did not finish uploading. Add it again." }, { status: 410 });
  const videos = files.filter((f) => f.kind === "video");
  if (videos.length > 0 && files.length > 1) {
    return NextResponse.json({ error: "On Facebook a video is posted on its own." }, { status: 400 });
  }

  try {
    const token = await channelToken(owner, connection);
    const urls = await Promise.all(files.map((f) => presignedGet(f.storageKey, 3 * 60 * 60)));
    const posted = await publishToPage(token, connection.accountId, {
      message: parsed.data.caption,
      photos: videos.length ? [] : urls,
      video: videos.length ? urls[0] : null,
    });
    // A video is fetched by Facebook while it processes, after this answers:
    // its file is left to the 24-hour sweep rather than deleted now.
    await forgetSocialMedia(owner, files.filter((f) => f.kind === "photo").map((f) => f.id));
    await recordAudit([
      {
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        agencyGrantId: decision.via?.grantId ?? null,
        action: videos.length ? "facebook.posted_video" : "facebook.posted",
        target: posted.permalink ?? posted.id,
      },
    ]);
    return NextResponse.json({ id: posted.id, permalink: posted.permalink });
  } catch (err) {
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    if (!(err instanceof MetaError)) throw err;
    return NextResponse.json(
      { error: err.signedOut ? "Facebook has signed this connection out. Connect it again." : err.message, signedOut: err.signedOut },
      { status: 502 },
    );
  }
}
