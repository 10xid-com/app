import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { InventoryError, markDocument } from "@/lib/db/inventory";
import { linkPaperwork, registerPaperwork } from "@/lib/db/purchases";
import { BucketError, mediaBucketConfigured, putObject } from "@/lib/integrations/media-bucket";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { hex, isSha256Hex, sniffPhoto } from "@/lib/inventory/files";
import { MAX_PAPERWORK_BYTES, isPdf, paperworkName } from "@/lib/inventory/purchase";

/**
 * An invoice or receipt for one container (app/inventory/containers/[id]).
 *
 * A PDF as it is, or a photo the container page has already redrawn (upright,
 * at most 2048px, without the camera's location data). What arrived is judged
 * from its first bytes — "%PDF-" or a photo type — never from its name or the
 * browser's word, and its hash is checked against the one the browser
 * computed. It is kept in the private media store under
 * `inventory/<business>/`, served only through the documents route, and
 * linked to this container as purchase paperwork once it is stored. The same
 * bytes again are the same document: one invoice can be attached to several
 * jars. It is never linked to a capture, so it is never shown to the label
 * reader, and attaching it changes nothing in the stock.
 *
 * inventory.write, CSRF and Origin checked by the central function.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, "inventory.write");
  if (!decision.allowed) {
    return NextResponse.json(
      { error: decision.reason === "signed_out" ? "Sign in again, then send the file." : "Your role cannot add to this inventory." },
      { status: decision.reason === "signed_out" ? 401 : 403 },
    );
  }
  if (!inventoryEnabledFor(decision.businessId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!mediaBucketConfigured()) return NextResponse.json({ error: "The portal has nowhere to keep files yet." }, { status: 503 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };
  const containerId = id.toLowerCase();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "The file did not arrive. Send it again." }, { status: 422 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose a PDF, or a photo of the invoice or receipt." }, { status: 400 });
  if (file.size > MAX_PAPERWORK_BYTES) return NextResponse.json({ error: "That file is over 9MB." }, { status: 413 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = isPdf(bytes) ? ({ contentType: "application/pdf", extension: "pdf" } as const) : sniffPhoto(bytes);
  if (!type) {
    return NextResponse.json({ error: "That is not an invoice or receipt 10XiD can keep: a PDF, or a photo (JPEG, PNG, WebP or HEIC)." }, { status: 415 });
  }
  const digest = createHash("sha256").update(bytes).digest();
  const claimed = form.get("sha256");
  if (typeof claimed === "string" && claimed && (!isSha256Hex(claimed) || claimed !== hex(digest))) {
    return NextResponse.json({ error: "The file changed on its way here. Send it again." }, { status: 422 });
  }

  try {
    const reg = await registerPaperwork(owner, containerId, {
      sha256: digest,
      contentType: type.contentType,
      byteSize: bytes.length,
      originalName: paperworkName(file.name),
      storageKey: `inventory/${owner.organizationId}/${randomBytes(24).toString("base64url")}.${type.extension}`,
    });
    if (reg.state !== "stored") {
      try {
        await putObject(reg.storageKey, bytes, reg.contentType);
      } catch (err) {
        await markDocument(owner, reg.documentId, "failed", err instanceof Error ? err.message.slice(0, 500) : "The store refused it.");
        throw err;
      }
      await markDocument(owner, reg.documentId, "stored", null);
    }
    const paper = await linkPaperwork(owner, containerId, reg.documentId);
    return NextResponse.json({ ...paper, addedAt: paper.addedAt.toISOString(), reused: !reg.created });
  } catch (err) {
    if (err instanceof InventoryError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    if (err instanceof BucketError) return NextResponse.json({ error: "The file could not be kept just now. Send it again." }, { status: 502 });
    throw err;
  }
}
