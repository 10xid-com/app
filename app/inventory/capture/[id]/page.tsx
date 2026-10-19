import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { resolveIdentity } from "@/lib/auth/session";
import { getCapture, productChoices, unitLabel } from "@/lib/db/inventory";
import { inventoryEnabledFor, visionUnavailability } from "@/lib/inventory/config";
import { suggestionsFrom, type ReviewField } from "@/lib/inventory/review";
import { PortalShell } from "../../../portal-shell";
import { CsrfField } from "../../../_components/csrf-field";
import { discardCaptureAction } from "../../actions";
import { ReviewForm, type ProductOption } from "./review-form";
import { CaptureWorkbench } from "./workbench";

export const metadata: Metadata = { title: "Catalogue an item" };

/**
 * One item being catalogued: its photos, what the label reader found, and the
 * form that saves it as a container in the inventory.
 *
 * Nothing on this page changes the inventory until Save: photos and readings
 * belong to the capture, and a capture can be discarded. Once saved it shows
 * what it became; saving again does nothing more.
 *
 * inventory.read to look, inventory.write (owners) to add photos and save; on
 * a business INVENTORY_BUSINESSES switches it on for, else a 404.
 */
export default async function CapturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const returnPath = `/inventory/capture/${id}`;
  const { ctx, businessId, role, via } = await requirePage("inventory.read", { returnPath });
  if (!inventoryEnabledFor(businessId)) notFound();
  const owner = { organizationId: businessId, userId: ctx.userId };

  const capture = await getCapture(owner, id);
  if (!capture) notFound();
  const mayWrite = allows(role, "inventory.write", via);

  const shell = (children: ReactNode) => (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <a href="/inventory" className="text-sm text-ink-soft hover:text-ink">
        ← Inventory
      </a>
      {children}
    </PortalShell>
  );

  if (capture.status === "confirmed") {
    return shell(
      <section className="mt-4 rounded-2xl border border-good/30 bg-good/5 p-6">
        <h1 className="text-xl font-semibold text-ink">Saved</h1>
        <p className="mt-1 text-sm text-ink">
          {capture.saved ? `${capture.saved.productName} is in the inventory.` : "This item is in the inventory."} It was saved once; saving
          again changes nothing.
        </p>
        <a href="/inventory" className="mt-4 inline-flex min-h-12 items-center rounded-xl bg-brand-surface px-5 py-3 font-semibold text-brand-on-surface">
          See the inventory
        </a>
      </section>,
    );
  }
  if (capture.status === "abandoned") {
    return shell(
      <section className="mt-4 rounded-2xl border border-line bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold text-ink">Discarded</h1>
        <p className="mt-1 text-sm text-ink-soft">This item was not saved. Its photos are kept as they were.</p>
      </section>,
    );
  }

  const identity = await resolveIdentity();
  const csrf = identity.state === "active" ? identity.csrfToken : "";
  const reader = visionUnavailability();
  const fields = capture.extraction?.status === "needs_review" ? capture.extraction.fields : [];
  const suggested = suggestionsFrom(fields);
  const sure = (name: string) => {
    const f = fields.find((x) => x.field === name);
    return f ? f.confidence : undefined;
  };
  const read: Partial<Record<ReviewField, number | null>> = {};
  const mark = (field: ReviewField, from: string, present: unknown) => {
    const c = sure(from);
    if (present !== undefined && c !== undefined) read[field] = c;
  };
  mark("productName", "product_name", suggested.productName);
  mark("brand", "brand", suggested.brand);
  mark("manufacturer", "manufacturer", suggested.manufacturer);
  mark("form", "form", suggested.form);
  mark("gtin", "gtin", suggested.gtin);
  mark("labelQuantity", "net_quantity", suggested.netQuantity);
  mark("lotCode", "lot_code", suggested.lotCode);
  mark("expiryDate", "expiry", suggested.expiry?.date ?? undefined);
  mark("expiryPrinted", "expiry", suggested.expiry?.printed ?? undefined);

  const choices = await productChoices(owner, { gtin: suggested.gtin, name: suggested.productName });
  const products: ProductOption[] = choices.map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    detail: [p.packageQuantity ? `${Number(p.packageQuantity)} ${unitLabel(p.packageUnit)}` : "", p.gtin ?? ""].filter(Boolean).join(", "),
    match: p.match,
  }));
  const sameBarcode = choices.find((p) => p.match === 2);

  const initial: Partial<Record<ReviewField, string>> = {
    product: sameBarcode?.id ?? "new",
    productName: suggested.productName ?? "",
    brand: suggested.brand ?? "",
    manufacturer: suggested.manufacturer ?? "",
    form: suggested.form ?? "unknown",
    gtin: suggested.gtin ?? "",
    labelQuantity: suggested.netQuantity?.amount ?? "",
    labelUnit: suggested.netQuantity?.unit ?? "",
    lotCode: suggested.lotCode ?? "",
    expiryPrinted: suggested.expiry?.printed ?? "",
    expiryDate: suggested.expiry?.date ?? "",
    expiryKind: suggested.expiry?.kind ?? "unknown",
    status: "sealed",
    amount: suggested.netQuantity ? "label" : "unknown",
  };

  const reused = capture.photos.flatMap((p) => p.evidenceFor);
  const evidenceWarning = reused.length ? (
    <div role="note" className="rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm text-ink">
      <p className="font-semibold">A photo here is already saved with another container.</p>
      <ul className="mt-1 list-disc pl-5">
        {[...new Map(reused.map((r) => [r.containerId, r])).values()].map((r) => (
          <li key={r.containerId}>
            {r.productName}, saved {r.createdAt.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
          </li>
        ))}
      </ul>
      <p className="mt-2">
        Saving this item makes <strong>another</strong> container — right for a second jar of the same thing. If it is the same jar, discard this
        item instead.
      </p>
    </div>
  ) : null;

  return shell(
    <>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Catalogue an item</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">One container: photograph it, check what was read, save it.</p>

      {mayWrite ? (
        <CaptureWorkbench
          captureId={capture.id}
          csrf={csrf}
          photos={capture.photos.map((p) => ({
            id: p.id,
            contentType: p.contentType,
            state: p.state,
            label: p.evidenceFor.length ? "Also on another jar" : null,
          }))}
          reader={reader}
          reading={capture.extraction ? { status: capture.extraction.status, error: capture.extraction.error } : null}
        />
      ) : (
        <p className="mt-6 text-sm text-ink-soft">Your role can see this inventory but not add to it.</p>
      )}

      {mayWrite ? (
        <section aria-labelledby="review-heading" className="mt-6">
          <h2 id="review-heading" className="sr-only">
            Check and save
          </h2>
          <ReviewForm
            key={capture.extraction?.id ?? "manual"}
            captureId={capture.id}
            csrf={csrf}
            initial={initial}
            read={read}
            products={products}
            evidenceWarning={evidenceWarning}
          />
          <form action={discardCaptureAction} className="mt-4">
            <CsrfField />
            <input type="hidden" name="captureId" value={capture.id} />
            <button type="submit" className="min-h-11 w-full rounded-xl px-4 py-2 text-sm text-ink-soft hover:bg-sunk hover:text-ink sm:w-auto">
              Discard this item
            </button>
          </form>
        </section>
      ) : null}
    </>,
  );
}
