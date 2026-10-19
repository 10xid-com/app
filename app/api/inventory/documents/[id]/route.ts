import { z } from "zod";
import { authorizeRequest } from "@/lib/auth/authorize";
import { documentForDownload } from "@/lib/db/inventory";
import { BucketError, getObject } from "@/lib/integrations/media-bucket";
import { inventoryEnabledFor } from "@/lib/inventory/config";

/**
 * One inventory file — a label photo, or an invoice or receipt — to someone
 * who may read this business's inventory.
 *
 * The document is looked up as the business in scope, so another business's
 * id is not found (row-level security), and only then is the private store
 * asked for the bytes. No presigned address is handed out: each view passes
 * through the central authorization function again. Never cached by anyone
 * else, never sniffed into something else.
 *
 * inventory.read, checked by the central function.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, "inventory.read");
  if (!decision.allowed) return new Response(null, { status: decision.reason === "signed_out" ? 401 : 403 });
  if (!inventoryEnabledFor(decision.businessId)) return new Response(null, { status: 404 });
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });

  const doc = await documentForDownload({ organizationId: decision.businessId, userId: decision.ctx.userId }, id);
  if (!doc) return new Response(null, { status: 404 });

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await getObject(doc.storageKey);
  } catch (err) {
    if (err instanceof BucketError) return new Response(null, { status: 502 });
    throw err;
  }
  return new Response(bytes, {
    headers: {
      "content-type": doc.contentType,
      "content-length": String(bytes.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": disposition(doc.originalName),
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

/**
 * Shown in the browser (a photo, or a PDF in its viewer), under the name it
 * came with, so saving it keeps that name. The plain name is ASCII without
 * quotes; the encoded one carries it exactly. Neither can break the header.
 */
function disposition(name: string | null): string {
  if (!name) return "inline";
  const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${plain}"; filename*=UTF-8''${exact}`;
}
