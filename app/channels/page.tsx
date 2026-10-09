import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { connectedChannels } from "@/lib/db/channels";
import { facebookConfig } from "@/lib/integrations/facebook";
import { instagramConfig } from "@/lib/integrations/instagram";
import { mediaBucketConfigured } from "@/lib/integrations/media-bucket";
import { PortalShell } from "../portal-shell";
import { Icon, type IconName } from "../_components/icons";
import { CHANNELS, ID_CHANNEL, SOON } from "../_components/sections";

export const metadata: Metadata = { title: "Channels" };

/**
 * Channels — the sidebar's "Add channel". Every place the business can show
 * up: the ones connected, and the ones it can connect, each going to its own
 * channel page where the connecting happens (and where who may connect is
 * checked again). The sidebar lists only the connected ones.
 */

type Card = {
  href: string;
  label: string;
  icon: IconName;
  blurb: string;
  state: "connected" | "available" | "setup" | "soon";
};

export default async function ChannelsPage() {
  const { ctx, businessId, role, via } = await requirePage("business.view", { returnPath: SOON.channels.href });
  const connected = await connectedChannels({ organizationId: businessId, userId: ctx.userId });
  const bucket = mediaBucketConfigured();
  const mayConnect = allows(role, "social.connect", via) || allows(role, "domains.manage", via);

  const cards: Card[] = [
    { ...ID_CHANNEL, blurb: "Your digital business card, and where the rest point to.", state: "connected" },
    { ...CHANNELS.website, state: connected.has("website") ? "connected" : "available" },
    {
      ...CHANNELS.instagram,
      state: connected.has("instagram") ? "connected" : instagramConfig() && bucket ? "available" : "setup",
    },
    {
      ...CHANNELS.facebook,
      state: connected.has("facebook") ? "connected" : facebookConfig() && bucket ? "available" : "setup",
    },
    { ...CHANNELS.linkedin, state: "soon" },
  ];
  const mine = cards.filter((c) => c.state === "connected");
  const more = cards.filter((c) => c.state !== "connected");

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Channels</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        Where your business shows up. Connect a channel to post to it, and see how it is doing, from here.
      </p>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-ink-faint">Connected</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {mine.map((c) => (
          <ChannelCard key={c.href} card={c} mayConnect={mayConnect} />
        ))}
      </ul>

      {more.length ? (
        <>
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-ink-faint">Add a channel</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {more.map((c) => (
              <ChannelCard key={c.href} card={c} mayConnect={mayConnect} />
            ))}
          </ul>
          {!mayConnect ? <p className="mt-3 text-sm text-ink-soft">An owner or manager can connect channels.</p> : null}
        </>
      ) : null}
    </PortalShell>
  );
}

const BADGE: Record<Card["state"], { text: string; className: string }> = {
  connected: { text: "Connected", className: "bg-good/10 text-good" },
  available: { text: "Connect", className: "bg-brand-surface text-brand-on-surface" },
  setup: { text: "Being set up", className: "bg-sunk text-ink-soft" },
  soon: { text: "Coming soon", className: "bg-sunk text-ink-soft" },
};

function ChannelCard({ card, mayConnect }: { card: Card; mayConnect: boolean }) {
  const badge = BADGE[card.state];
  const body = (
    <>
      <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-sunk text-ink-soft">
        <Icon name={card.icon} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-sm font-semibold text-ink">{card.label}</span>
        <span className="text-xs text-ink-soft">{card.blurb}</span>
      </span>
      <span className={`flex-none rounded-full px-2.5 py-1 text-xs font-semibold ${badge.className}`}>
        {card.state === "available" && !mayConnect ? "Not connected" : badge.text}
      </span>
    </>
  );
  const box = "flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card";
  return (
    <li>
      {card.state === "soon" ? (
        <div className={`${box} opacity-70`}>{body}</div>
      ) : (
        <Link href={card.href} className={`${box} transition-colors hover:bg-sunk`}>
          {body}
        </Link>
      )}
    </li>
  );
}
