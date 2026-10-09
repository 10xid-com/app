import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { newMediaKey, recordSocialMedia } from "@/lib/db/social";
import { jpegSize } from "@/lib/integrations/instagram";
import { BucketError, mediaBucketConfigured, putObject } from "@/lib/integrations/media-bucket";
import { sweepExpiredSocialMedia } from "@/lib/integrations/social-media";

/**
 * A photo for a post (Instagram, Facebook), kept in the media store until it
 * is posted (24 hours at most).
 *
 * Instagram takes JPEG only, so every photo is one: the composer converts and
 * crops in the browser, and this checks what arrived is a JPEG, reading its
 * size from the file rather than trusting the request. Each channel's own
 * post route checks the shape it takes.
 * social.publish, CSRF and Origin checked by the central function.
 */

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post here." }, { status: 403 });
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
