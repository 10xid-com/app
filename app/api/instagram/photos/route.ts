import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { newMediaKey, recordSocialMedia } from "@/lib/db/social";
import { jpegSize, RATIO_MAX, RATIO_MIN } from "@/lib/integrations/instagram";
import { BucketError, mediaBucketConfigured, putObject } from "@/lib/integrations/media-bucket";
import { sweepExpiredSocialMedia } from "@/lib/integrations/social-media";

/**
 * A photo for an Instagram post, kept in the media store until it is posted
 * (24 hours at most).
 *
 * Instagram takes JPEG only. The composer converts and crops in the browser;
 * this checks what arrived is a JPEG of a shape Instagram's feed accepts,
 * reading the size from the file rather than trusting the request.
 * social.publish, CSRF and Origin checked by the central function.
 */

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post to Instagram here." }, { status: 403 });
  if (!mediaBucketConfigured()) return NextResponse.json({ error: "The portal has nowhere to keep media yet." }, { status: 503 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("photo");
  } catch {
    return NextResponse.json({ error: "The photo did not arrive. Try again." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose a photo." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That photo is over 8MB." }, { status: 413 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = jpegSize(bytes);
  if (!size) return NextResponse.json({ error: "Instagram takes JPEG photos only." }, { status: 415 });
  const ratio = size.width / size.height;
  if (ratio < RATIO_MIN - 0.01 || ratio > RATIO_MAX + 0.01) {
    return NextResponse.json({ error: "Instagram's feed takes photos from 4:5 tall to 1.91:1 wide." }, { status: 422 });
  }

  try {
    await sweepExpiredSocialMedia(owner);
    const storageKey = newMediaKey(owner.organizationId, "image/jpeg");
    await putObject(storageKey, bytes, "image/jpeg");
    const row = await recordSocialMedia(owner, {
      kind: "photo",
      contentType: "image/jpeg",
      storageKey,
      byteSize: bytes.length,
      width: size.width,
      height: size.height,
      durationMs: null,
      uploadId: null,
      ready: true,
    });
    return NextResponse.json({ id: row.id });
  } catch (err) {
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    throw err;
  }
}
