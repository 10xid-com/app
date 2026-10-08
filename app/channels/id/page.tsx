import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/authorize";
import { organizationById } from "@/lib/db/identity";
import { PortalShell } from "../../portal-shell";
import { IdChannelView } from "./view";

export const metadata: Metadata = { title: "iD" };

/**
 * The iD channel: the business's own iD, the way the sketch of 2026-10-08
 * drew it — the live iD in a large card with its address and the two things
 * you do with it, and the themes it can wear underneath.
 *
 * The address is the business's slug under 10xid.com. Launching, editing and
 * adding a theme are not built yet; the buttons are here, and say so, so the
 * page already has the shape it will keep.
 */

export default async function IdChannelPage() {
  const { ctx, businessId } = await requirePage("business.view", { returnPath: "/channels/id" });
  const org = await organizationById(businessId);

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <IdChannelView
        name={org?.name ?? "Your business"}
        logo={org?.brandLogoUrl ?? "/10xid-mark.png"}
        address={org ? `${org.slug}.10xid.com` : "*.10xid.com"}
      />
    </PortalShell>
  );
}
