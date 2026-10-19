import "server-only";
import { ollamaConfig } from "@/lib/ai/ollama";
import { getObject } from "@/lib/integrations/media-bucket";
import { beginExtraction, captureImages, failExtraction, finishExtraction, type InventoryOwner } from "@/lib/db/inventory";
import { visionModel, visionUnavailability } from "./config";
import { modelCanRead } from "./files";
import { MAX_IMAGES, ReadError, askModel, checkVision, fieldsFromReading, forgetVisionChecks, withoutNul } from "./label-reader";

export { MAX_IMAGES, fieldsFromReading, withoutNul };

/**
 * Reading a capture's label photos with a vision model, and recording it.
 *
 * Only when INVENTORY_VISION_MODEL names one and this server may send client
 * material to it (lib/inventory/config.ts): otherwise nothing is sent and the
 * person fills the form in. How the model is asked and its answer read back
 * is lib/inventory/label-reader.ts — the same code the synthetic-label check
 * (scripts/check-label-reader.ts) runs against the real server.
 *
 * Before any photo is sent, the server is asked whether the model can see
 * images at all; a model that cannot, or a server that will not say, gets
 * nothing, and the reading is recorded as failed with the model named.
 *
 * At most MAX_IMAGES photos are read, oldest first, and HEIC is never sent
 * (models do not open it); the outcome says how many were left out and why,
 * so the screen can say so. Each run is recorded (inventory_extractions)
 * under the model's own name, with what it said, whether it worked or not.
 * The logs carry the model, the timings and the counts — never a photo, never
 * a word from a label.
 */

export type NotRead = {
  /** Beyond the MAX_IMAGES the reader is sent. */
  overLimit: number;
  /** HEIC or another type the reader cannot open. */
  unreadable: number;
};

export type ReadingOutcome =
  | { status: "off"; reason: string }
  | { status: "no_photos"; notRead: NotRead }
  | { status: "done"; extractionId: string; fields: number; read: number; notRead: NotRead }
  | { status: "failed"; extractionId: string; error: string; read: number; notRead: NotRead };

/** For tests: forget what the servers said about their models. */
export function forgetVisionCapabilities() {
  forgetVisionChecks();
}

/** Read the labels in a capture's photos, and record what was read. */
export async function readCaptureLabels(
  owner: InventoryOwner,
  captureId: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<ReadingOutcome> {
  const off = visionUnavailability();
  if (off) return { status: "off", reason: off };
  const model = visionModel()!;
  const server = ollamaConfig();

  const images = await captureImages(owner, captureId);
  const openable = images.filter((i) => modelCanRead(i.contentType));
  const readable = openable.slice(0, MAX_IMAGES);
  const notRead: NotRead = { overLimit: openable.length - readable.length, unreadable: images.length - openable.length };
  if (readable.length === 0) return { status: "no_photos", notRead };

  const doFetch = deps.fetch ?? fetch;
  const started = Date.now();
  const extractionId = await beginExtraction(owner, captureId, model);
  // Metadata only: never a photo, never a word of a label.
  const log = (outcome: string, fields: number) =>
    console.info(
      `[inventory] label reading ${outcome}: model=${model} photos=${readable.length} over_limit=${notRead.overLimit} unreadable=${notRead.unreadable} fields=${fields} ms=${Date.now() - started}`,
    );

  const vision = await checkVision(server, model, doFetch);
  if (!vision.ok) {
    await failExtraction(owner, extractionId, vision.reason);
    log("not sent", 0);
    return { status: "failed", extractionId, error: vision.reason, read: 0, notRead };
  }

  let answer: unknown;
  try {
    const encoded = await Promise.all(readable.map(async (i) => Buffer.from(await getObject(i.storageKey)).toString("base64")));
    answer = await askModel(server, model, encoded, doFetch);
    const fields = fieldsFromReading(answer, readable.map((i) => i.documentId));
    await finishExtraction(owner, extractionId, answer, fields);
    log("done", fields.length);
    return { status: "done", extractionId, fields: fields.length, read: readable.length, notRead };
  } catch (err) {
    const message = err instanceof ReadError ? err.message : "The label reader did not work this time.";
    // The error itself may quote the label (a database error carries its
    // parameters), so only its kind is logged.
    log(`failed (${err instanceof Error ? err.name : typeof err})`, 0);
    await failExtraction(owner, extractionId, message, answer === undefined ? undefined : withoutNul(answer));
    return { status: "failed", extractionId, error: message, read: readable.length, notRead };
  }
}
