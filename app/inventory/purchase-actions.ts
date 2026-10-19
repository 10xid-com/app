"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { InventoryError } from "@/lib/db/inventory";
import { saveContainerPurchase, savePreferredVendor } from "@/lib/db/purchases";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { fieldsOf } from "@/lib/inventory/container";
import { PREFERRED_FIELDS, PURCHASE_FIELDS, inTheFuture, preferredSchema, purchaseSchema } from "@/lib/inventory/purchase";

/**
 * A container's purchase details and its product's preferred seller
 * (lib/db/purchases.ts). Both optional, both saved from the container page,
 * separately from cataloguing: a refusal keeps what was typed and says beside
 * the field what is wrong; a stale page or a form already sent says so instead
 * of saving over someone else's change.
 */

export type PurchaseFormState = {
  error: string | null;
  field: string | null;
  /** What was typed, given back so a refusal costs nothing. */
  values: Record<string, string> | null;
  at: number;
};

const OUT_OF_DATE = "This page is out of date. Reload it and try again.";

const PURCHASE_ERRORS: Record<string, string> = {
  vendor: "A seller's name is at most 200 characters.",
  acquiredOn: "That is not a date.",
  price: "A price is a number with at most two decimals, like 18.50.",
  currency: "Choose the currency of the price.",
  documentId: "Choose the invoice or receipt again.",
};

async function requirePurchaseWriter(formData: FormData, returnPath: string) {
  const { ctx, businessId } = await requireAction("inventory.write", formData, { returnPath });
  if (!inventoryEnabledFor(businessId)) notFound();
  return { organizationId: businessId, userId: ctx.userId };
}

/** How this container was bought: seller, date, price with its currency, paperwork — any of them, or none known. */
export async function savePurchaseAction(_prev: PurchaseFormState, formData: FormData): Promise<PurchaseFormState> {
  const values = fieldsOf(formData, PURCHASE_FIELDS);
  const valid = z.uuid().safeParse(values.containerId).success;
  const page = valid ? `/inventory/containers/${values.containerId.toLowerCase()}` : "/inventory";
  const owner = await requirePurchaseWriter(formData, page);
  if (!valid) notFound();
  const refused = (field: string | null, error: string): PurchaseFormState => ({ error, field, values, at: Date.now() });

  const parsed = purchaseSchema.safeParse(values);
  if (!parsed.success) {
    const field = (parsed.error.issues[0]?.path[0] as string | undefined) ?? null;
    if (field === "version" || field === "requestKey" || field === "containerId") return refused(null, OUT_OF_DATE);
    return refused(field, (field && PURCHASE_ERRORS[field]) ?? "Something in the form needs another look.");
  }
  if (parsed.data.acquiredOn !== null && inTheFuture(parsed.data.acquiredOn, parsed.data.today)) {
    return refused("acquiredOn", "A purchase date cannot be after today.");
  }
  try {
    await saveContainerPurchase(owner, parsed.data);
  } catch (err) {
    if (err instanceof InventoryError) {
      if (err.code === "not_found") notFound();
      return refused(err.field ?? null, err.message);
    }
    throw err;
  }
  revalidatePath(page);
  redirect(`${page}?done=purchase`);
}

/** Where this container's product is bought from next time — or, left empty, nowhere in particular. */
export async function savePreferredVendorAction(_prev: PurchaseFormState, formData: FormData): Promise<PurchaseFormState> {
  const values = fieldsOf(formData, PREFERRED_FIELDS);
  const valid = z.uuid().safeParse(values.containerId).success;
  const page = valid ? `/inventory/containers/${values.containerId.toLowerCase()}` : "/inventory";
  const owner = await requirePurchaseWriter(formData, page);
  if (!valid) notFound();
  const refused = (field: string | null, error: string): PurchaseFormState => ({ error, field, values, at: Date.now() });

  const parsed = preferredSchema.safeParse(values);
  if (!parsed.success) {
    const field = (parsed.error.issues[0]?.path[0] as string | undefined) ?? null;
    if (field !== "vendor") return refused(null, OUT_OF_DATE);
    return refused("vendor", PURCHASE_ERRORS.vendor);
  }
  try {
    await savePreferredVendor(owner, parsed.data);
  } catch (err) {
    if (err instanceof InventoryError) {
      if (err.code === "not_found") notFound();
      return refused(err.field ?? null, err.message);
    }
    throw err;
  }
  revalidatePath(page);
  redirect(`${page}?done=preferred`);
}
