import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { markSocialMediaReady, socialMediaById } from "@/lib/db/social";
import { BucketError, completeMultipart, objectSize } from "@/lib/integrations/media-bucket";
import { forgetSocialMedia } from "@/lib/integrations/social-media";
import { partsFor } from "@/lib/integrations/video-limits";

/**
 * Put a video's parts together. The store checks every part's ETag; this
 * checks the whole is exactly the size the upload was started with. Then the
 * video can be posted.
 */

export const dynamic = "force-dynamic";

const body = z.object({
  parts: z.array(z.object({ part: z.number().int().min(1), etag: z.string().min(1).max(200) })).min(1).max(10_000),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post to Instagram here." }, { status: 403 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Bad upload." }, { status: 400 });
  const row = await socialMediaById(owner, id);
  if (!row || row.kind !== "video" || row.ready || !row.uploadId) {
    return NextResponse.json({ error: "That upload is not open. Add the video again." }, { status: 410 });
  }
  const parsed = body.safeParse(await request.json().catch(() => null));
  const expected = partsFor(row.byteSize);
  const numbers = new Set(parsed.success ? parsed.data.parts.map((p) => p.part) : []);
  if (!parsed.success || numbers.size !== expected || ![...numbers].every((n) => n <= expected)) {
    return NextResponse.json({ error: "Some of the video did not arrive. Add it again." }, { status: 400 });
  }

  try {
    await completeMultipart(row.storageKey, row.uploadId, parsed.data.parts);
    if ((await objectSize(row.storageKey)) !== row.byteSize) {
      await forgetSocialMedia(owner, [row.id]);
      return NextResponse.json({ error: "The video arrived the wrong size. Add it again." }, { status: 422 });
    }
    await markSocialMediaReady(owner, row.id);
    return NextResponse.json({ id: row.id });
  } catch (err) {
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    throw err;
  }
}
