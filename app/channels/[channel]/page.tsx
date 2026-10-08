import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/authorize";
import { PortalShell } from "../../portal-shell";
import { ComingSoonPage } from "../../_components/coming-soon";
import { CHANNELS, isChannelName } from "../../_components/sections";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  return { title: isChannelName(channel) ? CHANNELS[channel].label : "Channels" };
}

/**
 * A channel that cannot be connected yet. Answers for the names in CHANNELS
 * and nothing else: any other name is the same 404 as a page that never
 * existed.
 */
export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const { ctx } = await requirePage("business.view", { returnPath: `/channels/${encodeURIComponent(channel)}` });
  if (!isChannelName(channel)) notFound();
  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <ComingSoonPage section={CHANNELS[channel]} />
    </PortalShell>
  );
}
