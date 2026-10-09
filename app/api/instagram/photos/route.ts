import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { saveSocialPhoto } from "@/lib/db/social";
import { jpegSize, RATIO_MAX, RATIO_MIN } from "@/lib/integrations/instagram";

/**
 * A photo for an Instagram post, kept until it is posted (24 hours at most).
 *
 * Instagram fetches photos itself, from a public address, and takes JPEG
 * only. The composer converts and crops in the browser; this checks what
 * arrived is a JPEG of a shape Instagram's feed accepts, reading the size from
 * the file rather than trusting the request. social.publish, CSRF and Origin
 * checked by the central function.
 */

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "social.publish");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot post to Instagram here." }, { status: 403 });

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("photo");
  } catch {
    return NextResponse.json({ error: "The photo did not arrive. Try again." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose a photo." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That photo is over 8MB." }, { status: 413 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const size = jpegSize(bytes);
  if (!size) return NextResponse.json({ error: "Instagram takes JPEG photos only." }, { status: 415 });
  const ratio = size.width / size.height;
  if (ratio < RATIO_MIN - 0.01 || ratio > RATIO_MAX + 0.01) {
    return NextResponse.json({ error: "Instagram's feed takes photos from 4:5 tall to 1.91:1 wide." }, { status: 422 });
  }

  const { token } = await saveSocialPhoto(
    { organizationId: decision.businessId, userId: decision.ctx.userId },
    { bytes, width: size.width, height: size.height },
  );
  return NextResponse.json({ token });
}
