import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { socialMediaById } from "@/lib/db/social";
import { BucketError, uploadPart } from "@/lib/integrations/media-bucket";
import { partSize, partsFor } from "@/lib/integrations/video-limits";

/**
 * One part of a video upload: the raw bytes, exactly the size this part must
 * be for the size the upload was started with. Only to an upload this
 * business started and has not finished. Answers with the part's ETag, which
 * finishing needs.
 */

export const dynamic = "force-dynamic";

export async function PUT(request: Request, ctx: { params: Promise<{ id: string; part: string }> }) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post to Instagram here." }, { status: 403 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  const { id, part: raw } = await ctx.params;
  const part = Number(raw);
  if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isInteger(part) || part < 1) {
    return NextResponse.json({ error: "Bad part." }, { status: 400 });
  }
  const row = await socialMediaById(owner, id);
  if (!row || row.kind !== "video" || row.ready || !row.uploadId) {
    return NextResponse.json({ error: "That upload is not open. Add the video again." }, { status: 410 });
  }
  if (part > partsFor(row.byteSize)) return NextResponse.json({ error: "Bad part." }, { status: 400 });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length !== partSize(row.byteSize, part)) {
    return NextResponse.json({ error: "That part arrived incomplete. Try again." }, { status: 400 });
  }
  try {
    const etag = await uploadPart(row.storageKey, row.uploadId, part, bytes);
    return NextResponse.json({ etag });
  } catch (err) {
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    throw err;
  }
}
