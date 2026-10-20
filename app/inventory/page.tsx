import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { listInventory, openCaptures, unitLabel, type InventoryRow } from "@/lib/db/inventory";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { BASIS_LABELS, describeBalance } from "@/lib/inventory/review";
import { PortalShell } from "../portal-shell";
import { CsrfField } from "../_components/csrf-field";
import { Icon } from "../_components/icons";
import { SubmitButton } from "../_components/submit-button";
import { startCaptureAction } from "./actions";
import { AddNewProduct } from "./add-new-product";

export const metadata: Metadata = { title: "Inventory" };

/**
 * What the business has on hand: every sealed or open container, what it
 * holds and how that is known, its lot and date, where it is.
 *
 * Each container was catalogued from phone photos (/inventory/capture), and
 * opens on its own page (/inventory/containers/[id]). An
 * amount nobody knows yet says "Unknown", never 0 — the difference between
 * "out" and "not counted" is the whole point of an inventory.
 *
 * inventory.read (owners), on a business INVENTORY_BUSINESSES switches it on
 * for; anyone else gets the 404 every unknown address gets.
 */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { ctx, businessId, role, via } = await requirePage("inventory.read", { returnPath: "/inventory" });
  if (!inventoryEnabledFor(businessId)) notFound();
  const owner = { organizationId: businessId, userId: ctx.userId };
  const [rows, drafts] = await Promise.all([listInventory(owner), openCaptures(owner)]);
  const mayWrite = allows(role, "inventory.write", via);
  const { saved } = await searchParams;
  const savedRow = saved ? rows.find((r) => r.containerId === saved) : undefined;

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null} action={mayWrite ? <AddNewProduct /> : null}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Inventory</h1>
          <p className="mt-1 max-w-prose text-sm text-ink-soft">What you have on hand, from photos of each container.</p>
        </div>
        {mayWrite ? <StartButton /> : null}
      </div>

      {savedRow ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          Saved:{" "}
          <a href={`/inventory/containers/${savedRow.containerId}`} className="font-medium underline">
            {savedRow.productName}
          </a>
          .
        </p>
      ) : null}

      {drafts.length ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">Started, not saved</h2>
          <ul className="mt-2 grid gap-2">
            {drafts.map((d) => (
              <li key={d.id}>
                <a
                  href={`/inventory/capture/${d.id}`}
                  className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink shadow-card hover:bg-sunk"
                >
                  <span>
                    Item started {d.createdAt.toLocaleDateString("en-CA", { month: "short", day: "numeric" })} ·{" "}
                    {d.photos === 1 ? "1 photo" : `${d.photos} photos`}
                  </span>
                  <Icon name="chevron-right" className="h-4 w-4 text-ink-faint" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-6">
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-sunk text-ink-soft">
              <Icon name="inventory" className="h-7 w-7" />
            </span>
            <h2 className="mt-4 text-lg font-semibold text-ink">Nothing catalogued yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
              Photograph a container — the front, the back panel, the lot and date — check what was read, and save it.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-ink-soft">
              {rows.length === 1 ? "1 container" : `${rows.length} containers`}
            </p>
            <ul className="mt-2 grid gap-2">
              {rows.map((row) => (
                <ContainerCard key={row.containerId} row={row} />
              ))}
            </ul>
          </>
        )}
      </section>
    </PortalShell>
  );
}

function StartButton() {
  return (
    <form action={startCaptureAction}>
      <CsrfField />
      <SubmitButton
        pendingLabel="Starting…"
        className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-brand-surface px-5 py-3 text-base font-semibold text-brand-on-surface hover:bg-brand-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <Icon name="camera" />
        Catalogue an item
      </SubmitButton>
    </form>
  );
}

const EXPIRY_LABEL: Record<string, string> = { best_before: "Best before", expiry: "Expires", use_by: "Use by", unknown: "Date" };

function ContainerCard({ row }: { row: InventoryRow }) {
  const today = new Date().toISOString().slice(0, 10);
  const expired = row.expiryDate !== null && row.expiryDate < today;
  const amount = describeBalance(row.balance, row.balanceBasis, row.baseUnit);
  return (
    <li>
      <a
        href={`/inventory/containers/${row.containerId}`}
        className="flex gap-3 rounded-xl border border-line bg-surface p-3 shadow-card hover:bg-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {row.photoId ? (
          // eslint-disable-next-line @next/next/no-img-element -- a private, per-request image; next/image would cache it
          <img
            src={`/api/inventory/documents/${row.photoId}`}
            alt=""
            loading="lazy"
            className="h-16 w-16 flex-none rounded-lg bg-sunk object-cover"
          />
        ) : (
          <span className="grid h-16 w-16 flex-none place-items-center rounded-lg bg-sunk text-ink-faint">
            <Icon name="inventory" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">{row.productName}</p>
          {row.brand ? <p className="truncate text-sm text-ink-soft">{row.brand}</p> : null}
          <p className="mt-1 text-sm text-ink">
            <span className={row.balanceBasis === "unknown" ? "text-ink-soft" : "font-medium"}>{amount}</span>
            {row.balanceBasis !== "unknown" ? <span className="text-ink-faint"> · {BASIS_LABELS[row.balanceBasis] ?? row.balanceBasis}</span> : null}
            {row.nominalQuantity && row.nominalUnit && row.balanceBasis !== "labelled_unopened" ? (
              <span className="whitespace-nowrap text-ink-faint">
                {" "}
                · label {Number(row.nominalQuantity)} {unitLabel(row.nominalUnit)}
              </span>
            ) : null}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
            <span className="rounded-full bg-sunk px-2 py-0.5">{row.status === "sealed" ? "Sealed" : "Open"}</span>
            {row.expiryDate ? (
              <span className={expired ? "font-semibold text-bad" : undefined}>
                {EXPIRY_LABEL[row.expiryKind ?? "unknown"] ?? "Date"} {formatDate(row.expiryDate)}
                {expired ? " — past" : ""}
              </span>
            ) : null}
            {row.lotCode ? <span>Lot {row.lotCode}</span> : null}
            {row.location ? <span>{row.location}</span> : null}
            {row.hold !== "none" ? <span className="font-semibold text-warn">On hold</span> : null}
          </p>
        </div>
        <Icon name="chevron-right" className="h-4 w-4 flex-none self-center text-ink-faint" />
      </a>
    </li>
  );
}

/** A calendar date as printed on screen, without a timezone moving it a day. */
function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
