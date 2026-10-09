import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { newMediaKey, recordSocialMedia, socialMediaById } from "@/lib/db/social";
import { BucketError, deleteObject, presignedGet, putFile } from "@/lib/integrations/media-bucket";
import { forgetSocialMedia } from "@/lib/integrations/social-media";
import { editVideo, VideoEditError } from "@/lib/integrations/video-edit";
import { CROP_MAX, CROP_MIN, MAX_TEXTS, TEXT_MAX_CHARS } from "@/lib/integrations/video-edit-spec";
import { VIDEO_MAX_BYTES, VIDEO_MAX_MS, VIDEO_MIN_MS } from "@/lib/integrations/video-limits";

/**
 * Make a video's edits — trim, crop to a shape, mute, text — and turn it
 * into an MP4 every channel takes (lib/integrations/video-edit.ts). Every
 * video goes through here once it has uploaded, edited or not, so what is
 * posted is always the processed file.
 *
 * The source is one of this business's whole uploads; the result is stored
 * as a new upload, and the source is deleted. Answers with the new upload's
 * id, size and length. social.publish, CSRF and Origin checked by the
 * central function. Processing takes from seconds to a few minutes.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 900;

const ms = z.number().int().min(0).max(VIDEO_MAX_MS + 1000);
const body = z.object({
  startMs: ms,
  endMs: ms,
  crop: z.object({ ratio: z.number().min(CROP_MIN).max(CROP_MAX).nullable(), position: z.number().min(0).max(1) }),
  mute: z.boolean(),
  texts: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(TEXT_MAX_CHARS),
        position: z.enum(["top", "middle", "bottom"]),
        style: z.enum(["shadow", "box"]),
        startMs: ms,
        endMs: ms,
      }),
    )
    .max(MAX_TEXTS),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post here." }, { status: 403 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Bad upload." }, { status: 400 });
  const source = await socialMediaById(owner, id);
  if (!source || source.kind !== "video" || !source.ready) {
    return NextResponse.json({ error: "That video is not uploaded. Add it again." }, { status: 410 });
  }
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Those edits could not be read." }, { status: 400 });
  const edit = parsed.data;
  const length = Math.min(edit.endMs, source.durationMs ?? edit.endMs) - edit.startMs;
  if (length < VIDEO_MIN_MS) return NextResponse.json({ error: "Keep at least 3 seconds of the video." }, { status: 400 });

  const storageKey = newMediaKey(owner.organizationId, "video/mp4");
  try {
    const result = await editVideo(await presignedGet(source.storageKey, 60 * 60), edit, async (path, out) => {
      if (out.bytes > VIDEO_MAX_BYTES) throw new VideoEditError("The edited video is over 300MB. Trim it shorter.");
      await putFile(storageKey, path, "video/mp4");
      return out;
    });
    let row;
    try {
      row = await recordSocialMedia(owner, {
        kind: "video",
        contentType: "video/mp4",
        storageKey,
        byteSize: result.bytes,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        uploadId: null,
        ready: true,
      });
    } catch (err) {
      await deleteObject(storageKey).catch(() => undefined);
      throw err;
    }
    await forgetSocialMedia(owner, [source.id]);
    return NextResponse.json({ id: row.id, width: row.width, height: row.height, durationMs: row.durationMs });
  } catch (err) {
    if (err instanceof VideoEditError || err instanceof BucketError) {
      await deleteObject(storageKey).catch(() => undefined);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
