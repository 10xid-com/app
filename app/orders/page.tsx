import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/authorize";
import { PortalShell } from "../portal-shell";
import { ComingSoonPage } from "../_components/coming-soon";
import { SOON } from "../_components/sections";

export const metadata: Metadata = { title: "Orders" };

/** Not built yet: a member of the open business sees what it will be. */
export default async function OrdersPage() {
  const { ctx } = await requirePage("business.view", { returnPath: SOON.orders.href });
  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <ComingSoonPage section={SOON.orders} />
    </PortalShell>
  );
}
