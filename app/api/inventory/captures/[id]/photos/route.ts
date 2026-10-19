import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { InventoryError } from "@/lib/db/inventory";
import { BucketError, mediaBucketConfigured } from "@/lib/integrations/media-bucket";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { MAX_PHOTO_BYTES } from "@/lib/inventory/files";
import { PhotoError, addCapturePhoto } from "@/lib/inventory/photos";

/**
 * One photo into an open capture (app/inventory/capture/[id]).
 *
 * The capture screen sends a JPEG it made in the browser (upright, at most
 * 2048px, without the camera's location data), or the original HEIC when the
 * browser could not convert it. What arrived is judged from its bytes, its
 * hash is checked against the one the browser computed, and it is kept in the
 * private media store under `inventory/<business>/` — never with social
 * media's cleanup, and never handed out by a presigned address.
 *
 * Sending the same bytes again — a retry after a dropped connection, or the
 * same label photo for a second jar — answers with the same document. The
 * answer says which saved containers that file is already evidence for, so the
 * screen can say a second jar is a second container.
 *
 * inventory.write, CSRF and Origin checked by the central function.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, "inventory.write");
  if (!decision.allowed) {
    return NextResponse.json(
      { error: decision.reason === "signed_out" ? "Sign in again, then send the photo." : "Your role cannot add to this inventory." },
      { status: decision.reason === "signed_out" ? 401 : 403 },
    );
  }
  if (!inventoryEnabledFor(decision.businessId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!mediaBucketConfigured()) return NextResponse.json({ error: "The portal has nowhere to keep photos yet." }, { status: 503 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "The photo did not arrive. It will be sent again." }, { status: 400 });
  }
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose a photo." }, { status: 400 });
  if (file.size > MAX_PHOTO_BYTES) return NextResponse.json({ error: "That photo is over 9MB." }, { status: 413 });

  const claimed = form.get("sha256");
  const takenAt = Number(form.get("capturedAt"));
  const capturedAt = Number.isFinite(takenAt) && takenAt > 0 ? new Date(takenAt) : null;

  try {
    const photo = await addCapturePhoto(owner, id, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      claimedSha256: typeof claimed === "string" && claimed ? claimed : null,
      originalName: file.name ? file.name.slice(0, 200) : null,
      capturedAt: capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
    });
    return NextResponse.json(photo);
  } catch (err) {
    if (err instanceof PhotoError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof InventoryError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    throw err;
  }
}
