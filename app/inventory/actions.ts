"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { InventoryError, abandonCapture, confirmCapture, createCapture, removeCapturePhoto } from "@/lib/db/inventory";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { REVIEW_FIELDS, formValues, planOpening, reviewSchema, type ReviewField } from "@/lib/inventory/review";

/**
 * Inventory's server actions: start an item, save it, discard it.
 *
 * The business is the session's, never the form's; the central authorization
 * function decides who may (inventory.write, owners), and Inventory must be
 * switched on for that business (INVENTORY_BUSINESSES) or it is a 404 like
 * any address that does not exist.
 */

async function requireInventoryWriter(formData: FormData, returnPath: string) {
  const { ctx, businessId } = await requireAction("inventory.write", formData, { returnPath });
  if (!inventoryEnabledFor(businessId)) notFound();
  return { organizationId: businessId, userId: ctx.userId };
}

/** A new capture, then straight to its camera. */
export async function startCaptureAction(formData: FormData) {
  const owner = await requireInventoryWriter(formData, "/inventory/capture");
  const id = await createCapture(owner);
  redirect(`/inventory/capture/${id}`);
}

export type ReviewState = {
  error: string | null;
  field: ReviewField | null;
  /** What was typed, given back so a refusal costs nothing. */
  values: Partial<Record<ReviewField, string>> | null;
  at: number;
};

const FIELD_ERRORS: Partial<Record<ReviewField, string>> = {
  product: "Choose the product, or a new one.",
  productName: "What is it called?",
  gtin: "A barcode number is 8 to 14 digits.",
  labelQuantity: "The label amount is a number, like 500 or 12.5.",
  labelUnit: "Choose the label's unit.",
  expiryDate: "That is not a date.",
  status: "Is it sealed or opened?",
  amount: "Choose how the amount is known.",
  grossG: "The scale's weight is a number of grams.",
  tareG: "The empty weight is a number of grams.",
  estimateQuantity: "The estimate is a number.",
  estimateUnit: "Choose the estimate's unit.",
  acquiredOn: "That is not a date.",
};

/**
 * Save the reviewed item: product, lot, container, any weighing, and its one
 * opening event (lib/db/inventory.ts confirmCapture). Pressing it twice, or
 * from two tabs, saves once.
 */
export async function saveCaptureAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  const values = formValues(formData);
  const captureId = z.uuid().safeParse(values.captureId).success ? values.captureId! : null;
  const owner = await requireInventoryWriter(formData, captureId ? `/inventory/capture/${captureId}` : "/inventory");
  const refused = (field: ReviewField | null, error: string): ReviewState => ({ error, field, values, at: Date.now() });

  const parsed = reviewSchema.safeParse(Object.fromEntries(REVIEW_FIELDS.map((f) => [f, values[f] ?? ""])));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = (issue?.path[0] as ReviewField | undefined) ?? null;
    return refused(field, (field && FIELD_ERRORS[field]) ?? issue?.message ?? "Something in the form needs another look.");
  }
  const plan = planOpening(parsed.data);
  if (!plan.ok) return refused(plan.field, plan.error);

  let containerId: string;
  try {
    ({ containerId } = await confirmCapture(owner, parsed.data, plan.plan));
  } catch (err) {
    if (err instanceof InventoryError) {
      if (err.code === "not_found") notFound();
      return refused((err.field as ReviewField | undefined) ?? null, err.message);
    }
    throw err;
  }
  revalidatePath("/inventory");
  redirect(`/inventory?saved=${containerId}`);
}

/** Discard an item that was started and not saved. A saved one stays saved. */
export async function discardCaptureAction(formData: FormData) {
  const raw = formData.get("captureId");
  const owner = await requireInventoryWriter(formData, "/inventory");
  if (typeof raw === "string" && z.uuid().safeParse(raw).success) await abandonCapture(owner, raw);
  revalidatePath("/inventory");
  redirect("/inventory");
}

/**
 * Take a photo out of an item that is still open: the way on when a photo
 * never finished arriving, since the item cannot be saved until every photo
 * of it has. The file and anything else it is evidence for are kept.
 */
export async function removePhotoAction(formData: FormData) {
  const captureId = formData.get("captureId");
  const documentId = formData.get("documentId");
  const valid = typeof captureId === "string" && z.uuid().safeParse(captureId).success;
  const owner = await requireInventoryWriter(formData, valid ? `/inventory/capture/${captureId}` : "/inventory");
  if (!valid || typeof documentId !== "string" || !z.uuid().safeParse(documentId).success) notFound();
  try {
    await removeCapturePhoto(owner, captureId, documentId);
  } catch (err) {
    if (err instanceof InventoryError && err.code === "not_found") notFound();
    if (!(err instanceof InventoryError)) throw err;
    // A saved or discarded item keeps its photos; its page says what it is now.
  }
  revalidatePath(`/inventory/capture/${captureId}`);
  redirect(`/inventory/capture/${captureId}`);
}
