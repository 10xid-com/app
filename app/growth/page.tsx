import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/authorize";
import { PortalShell } from "../portal-shell";
import { ComingSoonPage } from "../_components/coming-soon";
import { SOON } from "../_components/sections";

export const metadata: Metadata = { title: "Growth" };

/** Not built yet: a member of the open business sees what it will be. */
export default async function GrowthPage() {
  const { ctx } = await requirePage("business.view", { returnPath: SOON.growth.href });
  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <ComingSoonPage section={SOON.growth} />
    </PortalShell>
  );
}
