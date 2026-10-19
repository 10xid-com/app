import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { openCaptures } from "@/lib/db/inventory";
import { inventoryEnabledFor } from "@/lib/inventory/config";
import { PortalShell } from "../../portal-shell";
import { CsrfField } from "../../_components/csrf-field";
import { Icon } from "../../_components/icons";
import { SubmitButton } from "../../_components/submit-button";
import { startCaptureAction } from "../actions";

export const metadata: Metadata = { title: "Catalogue an item" };

/**
 * Where cataloguing starts on a phone: one button, and the items already
 * started. Worth keeping on the home screen — signing in from here comes back
 * here.
 *
 * Starting makes an empty capture and opens its camera
 * (/inventory/capture/[id]); nothing is in the inventory until it is saved.
 */
export default async function CaptureStartPage() {
  const { ctx, businessId, role, via } = await requirePage("inventory.read", { returnPath: "/inventory/capture" });
  if (!inventoryEnabledFor(businessId)) notFound();
  const drafts = await openCaptures({ organizationId: businessId, userId: ctx.userId });
  const mayWrite = allows(role, "inventory.write", via);

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <a href="/inventory" className="text-sm text-ink-soft hover:text-ink">
        ← Inventory
      </a>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Catalogue an item</h1>
      <ol className="mt-4 grid max-w-prose gap-2 text-sm text-ink">
        <li className="flex gap-3 rounded-lg bg-sunk px-3 py-2">
          <span className="font-semibold text-brand">1</span>
          Photograph one container: the front, the back panel, and the lot and date.
        </li>
        <li className="flex gap-3 rounded-lg bg-sunk px-3 py-2">
          <span className="font-semibold text-brand">2</span>
          Check what was read, and fix anything that is wrong. Leave out what you do not know.
        </li>
        <li className="flex gap-3 rounded-lg bg-sunk px-3 py-2">
          <span className="font-semibold text-brand">3</span>
          Save. One container, saved once.
        </li>
      </ol>

      {mayWrite ? (
        <form action={startCaptureAction} className="mt-6">
          <CsrfField />
          <SubmitButton
            pendingLabel="Starting…"
            className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand-surface px-5 py-3 text-base font-semibold text-brand-on-surface hover:bg-brand-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:w-auto"
          >
            <Icon name="camera" />
            Start
          </SubmitButton>
        </form>
      ) : (
        <p className="mt-6 text-sm text-ink-soft">Your role can see this inventory but not add to it.</p>
      )}

      {drafts.length ? (
        <section className="mt-8">
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
    </PortalShell>
  );
}
