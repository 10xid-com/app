import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { newMediaKey, recordSocialMedia } from "@/lib/db/social";
import { BucketError, mediaBucketConfigured, startMultipart } from "@/lib/integrations/media-bucket";
import { sweepExpiredSocialMedia } from "@/lib/integrations/social-media";
import { VIDEO_MAX_BYTES, VIDEO_MAX_MS, VIDEO_MIN_MS, VIDEO_PART_BYTES, VIDEO_TYPES } from "@/lib/integrations/video-limits";

/**
 * Start a video upload for a post (Instagram, Facebook). The video then comes up in
 * parts (./[id]/parts/[part]) and is put together (./[id]/complete); until
 * then it cannot be posted. social.publish, CSRF and Origin checked by the
 * central function.
 */

export const dynamic = "force-dynamic";

const body = z.object({
  contentType: z.enum(VIDEO_TYPES),
  byteSize: z.number().int().min(1).max(VIDEO_MAX_BYTES),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  durationMs: z.number().int().min(VIDEO_MIN_MS).max(VIDEO_MAX_MS),
});

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post here." }, { status: 403 });
  if (!mediaBucketConfigured()) return NextResponse.json({ error: "The portal has nowhere to keep media yet." }, { status: 503 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Videos must be MP4 or MOV, 3 seconds to 15 minutes, up to 300MB." },
      { status: 400 },
    );
  }
  const v = parsed.data;

  try {
    await sweepExpiredSocialMedia(owner);
    const storageKey = newMediaKey(owner.organizationId, v.contentType);
    const uploadId = await startMultipart(storageKey, v.contentType);
    const row = await recordSocialMedia(owner, {
      kind: "video",
      contentType: v.contentType,
      storageKey,
      byteSize: v.byteSize,
      width: v.width,
      height: v.height,
      durationMs: v.durationMs,
      uploadId,
      ready: false,
    });
    return NextResponse.json({ id: row.id, partBytes: VIDEO_PART_BYTES });
  } catch (err) {
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    throw err;
  }
}
