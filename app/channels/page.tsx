import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { PortalShell } from "../portal-shell";
import { ComingSoonPage } from "../_components/coming-soon";
import { Icon } from "../_components/icons";
import { CHANNELS, ID_CHANNEL, SOON } from "../_components/sections";

export const metadata: Metadata = { title: "Channels" };

/**
 * Every channel the business can show up on. The iD is always there; the rest
 * are placeholders until they can be connected, and adding one of your own
 * choosing is part of what this screen will become.
 */
export default async function ChannelsPage() {
  const { ctx } = await requirePage("business.view", { returnPath: SOON.channels.href });
  const channels = [ID_CHANNEL, ...Object.values(CHANNELS)];
  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <ComingSoonPage section={SOON.channels}>
        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-ink-faint">Your channels</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {channels.map((c) => (
            <li key={c.href}>
              <Link
                href={c.href}
                className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card transition-colors hover:bg-sunk"
              >
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-sunk text-ink-soft">
                  <Icon name={c.icon} />
                </span>
                <span className="text-sm font-medium text-ink">{c.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </ComingSoonPage>
    </PortalShell>
  );
}
