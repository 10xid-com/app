import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { InventoryError } from "@/lib/db/inventory";
import { BucketError } from "@/lib/integrations/media-bucket";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { MAX_IMAGES, readCaptureLabels } from "@/lib/inventory/extract";

/**
 * "Read the labels": the capture's photos to the label reader
 * (lib/inventory/extract.ts), and what it read recorded for review.
 *
 * Only when this server is set up to send label photos to a model; otherwise
 * it answers 409 with why, sends nothing, and the review form is filled in by
 * hand. Reading never saves anything to the inventory: the person reviews
 * every value first.
 *
 * inventory.write, CSRF and Origin checked by the central function.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, "inventory.write");
  if (!decision.allowed) {
    return NextResponse.json(
      { error: decision.reason === "signed_out" ? "Sign in again." : "Your role cannot add to this inventory." },
      { status: decision.reason === "signed_out" ? 401 : 403 },
    );
  }
  if (!inventoryEnabledFor(decision.businessId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };

  try {
    const outcome = await readCaptureLabels(owner, id);
    switch (outcome.status) {
      case "off":
        return NextResponse.json({ error: `Automatic reading is off. ${outcome.reason}` }, { status: 409 });
      case "no_photos":
        return NextResponse.json(
          { error: outcome.notRead.unreadable ? "These photos are HEIC, which the reader cannot open. Fill in what you can." : "Add a photo first." },
          { status: 400 },
        );
      case "done":
        return NextResponse.json({ status: "done", fields: outcome.fields, read: outcome.read, notRead: outcome.notRead, limit: MAX_IMAGES });
      case "failed":
        return NextResponse.json({ status: "failed", error: outcome.error, read: outcome.read, notRead: outcome.notRead, limit: MAX_IMAGES });
    }
  } catch (err) {
    if (err instanceof InventoryError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    if (err instanceof BucketError) return NextResponse.json({ error: err.message }, { status: 502 });
    throw err;
  }
}
