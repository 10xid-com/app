import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { putObject } from "@/lib/integrations/media-bucket";
import {
  documentEvidence,
  markDocument,
  registerCapturePhoto,
  type InventoryOwner,
} from "@/lib/db/inventory";
import { MAX_PHOTO_BYTES, hex, isSha256Hex, sniffPhoto } from "./files";

/**
 * One photo into a capture: checked, recorded, stored, linked.
 *
 * The row comes first (pending), the file second, then the row says stored —
 * so a dropped connection leaves a pending document that the next attempt of
 * the same bytes finishes, rather than a file nobody knows about. The bytes'
 * hash names the document: the same photo sent twice (a retry, or the same
 * label for a second jar) is one document, linked to every capture it is in.
 */

export class PhotoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PhotoError";
  }
}

export type AddedPhoto = {
  documentId: string;
  contentType: string;
  /** This file was already one of the business's documents. */
  reused: boolean;
  /** Containers already saved with this same file as evidence. */
  evidenceFor: { containerId: string; productName: string; createdAt: string }[];
};

export async function addCapturePhoto(
  owner: InventoryOwner,
  captureId: string,
  input: {
    bytes: Uint8Array<ArrayBuffer>;
    /** The browser's SHA-256 of what it sent, hex; checked when present. */
    claimedSha256: string | null;
    originalName: string | null;
    capturedAt: Date | null;
  },
): Promise<AddedPhoto> {
  if (input.bytes.length === 0) throw new PhotoError("Choose a photo.", 400);
  if (input.bytes.length > MAX_PHOTO_BYTES) throw new PhotoError("That photo is over 9MB.", 413);
  const type = sniffPhoto(input.bytes);
  if (!type) throw new PhotoError("That is not a photo 10XiD can keep: JPEG, PNG, WebP or HEIC.", 415);

  const digest = createHash("sha256").update(input.bytes).digest();
  if (input.claimedSha256 !== null && (!isSha256Hex(input.claimedSha256) || input.claimedSha256 !== hex(digest))) {
    throw new PhotoError("The photo changed on its way here. It will be sent again.", 422);
  }

  const reg = await registerCapturePhoto(owner, captureId, {
    sha256: digest,
    contentType: type.contentType,
    byteSize: input.bytes.length,
    originalName: input.originalName,
    capturedAt: input.capturedAt,
    storageKey: `inventory/${owner.organizationId}/${randomBytes(24).toString("base64url")}.${type.extension}`,
  });

  if (reg.state !== "stored") {
    try {
      await putObject(reg.storageKey, input.bytes, reg.contentType);
    } catch (err) {
      await markDocument(owner, reg.documentId, "failed", err instanceof Error ? err.message.slice(0, 500) : "The store refused it.");
      throw err;
    }
    await markDocument(owner, reg.documentId, "stored", null);
  }

  const evidence = await documentEvidence(owner, reg.documentId);
  return {
    documentId: reg.documentId,
    contentType: reg.contentType,
    reused: !reg.created,
    evidenceFor: evidence.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}
