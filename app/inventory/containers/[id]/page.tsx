import type { Metadata } from "next";
import type { ReactNode } from "react";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { resolveIdentity } from "@/lib/auth/session";
import { getContainer, unitLabel, type ContainerMovement, type ContainerView } from "@/lib/db/inventory";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { unitsFor } from "@/lib/inventory/container";
import { BASIS_LABELS, UNITS, describeBalance } from "@/lib/inventory/review";
import { PortalShell } from "../../../portal-shell";
import { AmountForm, DetailsForm, LocalTime, OpenForm } from "./container-forms";

export const metadata: Metadata = { title: "Container" };

/**
 * One container: what it is, its photos, what is in it now and how that is
 * known, and every event that says so — and, for whoever may add to the
 * inventory, saying what is in it now, opening it, and where it is.
 *
 * What is in it is never overwritten: a new amount is a new event, and the
 * label, the opening and every earlier event stay as they were recorded.
 * Unknown reads "Unknown", never 0.
 *
 * inventory.read to look, inventory.write to change; on a business
 * INVENTORY_BUSINESSES switches inventory on for, else a 404 — as is another
 * business's container.
 */
export default async function ContainerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, businessId, role, via } = await requirePage("inventory.read", { returnPath: `/inventory/containers/${id}` });
  if (!inventoryEnabledFor(businessId)) notFound();
  const c = await getContainer({ organizationId: businessId, userId: ctx.userId }, id);
  if (!c) notFound();
  const mayWrite = allows(role, "inventory.write", via);
  const identity = await resolveIdentity();
  const csrf = identity.state === "active" ? identity.csrfToken : "";
  const { done } = await searchParams;

  const onShelf = c.status === "sealed" || c.status === "open";
  const units = unitsFor(c.dimension).map((code) => ({ code, label: UNITS[code].label }));
  const labelBased = c.balanceBasis === "labelled_unopened";

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <a href="/inventory" className="text-sm text-ink-soft hover:text-ink">
        ← Inventory
      </a>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{c.product.name}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
        {c.product.brand ? <span>{c.product.brand}</span> : null}
        <span className="rounded-full bg-sunk px-2 py-0.5 text-xs">{STATUS[c.status] ?? c.status}</span>
        {c.lot.hold !== "none" ? <span className="text-xs font-semibold text-warn">On hold</span> : null}
      </p>

      {done && DONE[done] ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          {DONE[done]}
        </p>
      ) : null}

      {c.photos.length ? (
        <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {c.photos.map((p) => (
            <li key={p.id} className="aspect-square overflow-hidden rounded-lg bg-sunk">
              <a href={`/api/inventory/documents/${p.id}`} className="block h-full w-full">
                {/* eslint-disable-next-line @next/next/no-img-element -- a private photo served per request */}
                <img src={`/api/inventory/documents/${p.id}`} alt="" loading="lazy" className="h-full w-full object-cover" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <Card title="In it now">
        <p className="text-2xl font-semibold text-ink">{describeBalance(c.balance, c.balanceBasis, c.baseUnit)}</p>
        <p className="text-sm text-ink-soft">
          {c.balanceBasis === "unknown" ? "Not known yet" : BASIS_LABELS[c.balanceBasis] ?? c.balanceBasis}
          {c.balanceAsOf && c.balanceBasis !== "unknown" ? (
            <>
              {" · "}
              <LocalTime iso={c.balanceAsOf.toISOString()} />
            </>
          ) : null}
        </p>
        {c.nominal ? (
          <p className="text-sm text-ink-soft">
            The label says {trim(c.nominal.quantity)} {unitLabel(c.nominal.unit)} when new.
          </p>
        ) : null}

        {mayWrite && onShelf ? (
          <div className="mt-2 grid gap-3">
            {c.status === "sealed" && labelBased ? (
              <details className="rounded-xl border border-line p-3">
                <summary className="cursor-pointer text-base font-semibold text-ink">Mark opened</summary>
                <p className="mt-2 text-sm text-ink-soft">
                  Once it is open, the label no longer says what is in it. Say about how much is in it now, or weigh it.
                </p>
                <div className="mt-3">
                  <AmountForm
                    containerId={c.id}
                    csrf={csrf}
                    version={c.version}
                    requestKey={randomUUID()}
                    intent="open"
                    units={units}
                    canWeigh={c.dimension === "mass"}
                    tare={c.tare}
                    submitLabel="Mark opened"
                  />
                </div>
              </details>
            ) : c.status === "sealed" ? (
              <div className="grid gap-1">
                <OpenForm containerId={c.id} csrf={csrf} version={c.version} requestKey={randomUUID()} />
                <p className="text-xs text-ink-soft">
                  {c.balanceBasis === "unknown" ? "Its amount stays unknown until you record one." : "Its amount stays as recorded."}
                </p>
              </div>
            ) : null}
            <details className="rounded-xl border border-line p-3">
              <summary className="cursor-pointer text-base font-semibold text-ink">Record remaining amount</summary>
              <div className="mt-3">
                <AmountForm
                  containerId={c.id}
                  csrf={csrf}
                  version={c.version}
                  requestKey={randomUUID()}
                  intent="amount"
                  units={units}
                  canWeigh={c.dimension === "mass"}
                  tare={c.tare}
                  submitLabel="Save amount"
                />
              </div>
            </details>
          </div>
        ) : null}
      </Card>

      <Card title="Where it is">
        {mayWrite ? (
          <DetailsForm containerId={c.id} csrf={csrf} version={c.version} location={c.location} notes={c.notes} />
        ) : (
          <dl className="grid gap-2 text-sm">
            <Row label="Place">{c.location ?? "Not recorded"}</Row>
            {c.notes ? <Row label="Notes">{c.notes}</Row> : null}
          </dl>
        )}
      </Card>

      <Card title="What it is">
        <dl className="grid gap-2 text-sm">
          <Row label="Name">
            {c.product.name}
            {c.product.variant ? ` — ${c.product.variant}` : ""}
          </Row>
          {c.product.brand ? <Row label="Brand">{c.product.brand}</Row> : null}
          {c.product.maker ? (
            <Row label="Made by">
              {c.product.maker.name}
              {c.product.maker.idCode ? <span className="ml-2 rounded bg-sunk px-1.5 py-0.5 font-mono text-xs">iD {c.product.maker.idCode}</span> : null}
            </Row>
          ) : null}
          {c.product.form !== "unknown" ? <Row label="Form">{FORMS[c.product.form] ?? c.product.form}</Row> : null}
          {c.product.gtin ? <Row label="Barcode">{c.product.gtin}</Row> : null}
          {c.product.packageQuantity && c.product.packageUnit ? (
            <Row label="Package">
              {trim(c.product.packageQuantity)} {unitLabel(c.product.packageUnit)}
            </Row>
          ) : null}
          {c.product.material ? <Row label="One ingredient">{c.product.material}</Row> : null}
        </dl>
      </Card>

      <Card title="Lot and date">
        <dl className="grid gap-2 text-sm">
          <Row label="Lot">{c.lot.code ?? "Not recorded"}</Row>
          <Row label={EXPIRY[c.lot.expiryKind ?? "unknown"] ?? "Date"}>
            {c.lot.expiryDate ? formatDay(c.lot.expiryDate) : "Not recorded"}
            {c.lot.expiryPrinted ? <span className="text-ink-soft"> (printed “{c.lot.expiryPrinted}”)</span> : null}
          </Row>
          {c.lot.acquiredOn ? <Row label="Bought">{formatDay(c.lot.acquiredOn)}</Row> : null}
          {c.openedOn ? <Row label="Opened">{formatDay(c.openedOn)}</Row> : null}
          {c.lot.hold !== "none" ? <Row label="On hold">{c.lot.holdReason ?? c.lot.hold}</Row> : null}
        </dl>
      </Card>

      <Card title="History">
        <ol className="grid gap-3">
          {history(c).map((item) =>
            item.type === "movement" ? (
              <li key={`m-${item.m.id}`} className={`text-sm ${item.m.voided ? "text-ink-faint line-through" : "text-ink"}`}>
                <p className="font-medium">{describe(item.m).title}</p>
                <p className={item.m.voided ? "" : "text-ink-soft"}>{describe(item.m).detail}</p>
                <p className="text-xs text-ink-faint">
                  <LocalTime iso={item.at.toISOString()} />
                  {item.m.byYou ? " · you" : ""}
                  {item.m.voided ? " · voided" : ""}
                </p>
              </li>
            ) : (
              <li key={`a-${item.e.id}`} className="text-sm text-ink">
                <p className="font-medium">{CHANGE[item.e.action] ?? "Changed"}</p>
                <p className="text-xs text-ink-faint">
                  <LocalTime iso={item.at.toISOString()} />
                  {item.e.byYou ? " · you" : ""}
                </p>
              </li>
            ),
          )}
        </ol>
      </Card>
    </PortalShell>
  );
}

const STATUS: Record<string, string> = { sealed: "Sealed", open: "Open", empty: "Empty", disposed: "Gone" };

const DONE: Record<string, string> = { amount: "Amount saved.", opened: "Marked opened.", details: "Saved." };

const EXPIRY: Record<string, string> = { best_before: "Best before", expiry: "Expires", use_by: "Use by", unknown: "Date" };

const FORMS: Record<string, string> = {
  powder: "Powder",
  extract_powder: "Extract powder",
  juice_powder: "Juice powder",
  granules: "Granules",
  crystals: "Crystals",
  whole: "Whole",
  cut: "Cut",
  liquid: "Liquid",
  capsules: "Capsules",
  tablets: "Tablets",
  other: "Other",
};

const KIND: Record<string, string> = {
  opening: "Catalogued",
  count: "Amount recorded",
  receipt: "Received",
  fill: "Filled",
  production_output: "Made",
  production_use: "Used in a batch",
  adjustment: "Adjusted",
  loss: "Lost",
  disposal: "Thrown away",
  transfer_in: "Moved in",
  transfer_out: "Moved out",
  return: "Returned",
  reversal: "An earlier entry voided",
};

const CHANGE: Record<string, string> = {
  "inventory.container.opened": "Marked opened",
  "inventory.container.place_changed": "Place changed",
  "inventory.container.notes_changed": "Notes changed",
  "inventory.evidence.added_after_save": "Photo added after saving",
};

type HistoryItem =
  | { type: "movement"; at: Date; m: ContainerMovement }
  | { type: "change"; at: Date; e: ContainerView["changes"][number] };

/** The ledger's events and the other changes, newest first. */
function history(c: ContainerView): HistoryItem[] {
  return [
    ...c.movements.map((m): HistoryItem => ({ type: "movement", at: m.occurredAt, m })),
    ...c.changes.map((e): HistoryItem => ({ type: "change", at: e.at, e })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** One ledger event in words: what it says is in the container (or changed), and how that is known. */
function describe(m: ContainerMovement): { title: string; detail: string } {
  const title = KIND[m.kind] ?? m.kind;
  if (m.kind === "reversal") return { title, detail: m.note ?? "" };
  if (m.quantity === null || m.basis === "unknown") return { title, detail: "Amount not known" };
  const amount = `${trim(m.quantity)} ${unitLabel(m.unit)}`;
  const w = m.measurement;
  let detail: string;
  if (m.basis === "labelled_unopened") detail = `${amount}, as labelled, sealed`;
  else if (w && m.basis === "measured") detail = `${amount}, weighed (${trim(w.grossG ?? "")} g on the scale, empty container ${trim(w.tareG ?? "")} g)`;
  else if (w) detail = `About ${amount}: weighed ${trim(w.grossG ?? "")} g, empty container about ${trim(w.tareG ?? "")} g`;
  else if (m.basis === "estimated") detail = `About ${amount}`;
  else detail = `${amount}${m.basis ? `, ${BASIS_LABELS[m.basis] ?? m.basis}` : ""}`;
  if (m.note && m.kind !== "opening" && m.kind !== "count") detail += ` — ${m.note}`;
  return { title, detail };
}

/** "320.0000" → "320", "12.5000" → "12.5". */
function trim(n: string): string {
  if (n === "") return "";
  const v = Number(n);
  return Number.isFinite(v) ? String(Number(v.toFixed(3))) : n;
}

/** A calendar day as printed on screen, without a time zone moving it a day. */
function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 grid gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}
