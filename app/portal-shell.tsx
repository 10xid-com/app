import type { ReactNode } from "react";
import { signOutAction } from "./auth/actions";
import { exitClientAction } from "./staff/actions";
import { PortalHeader, menuItemClass } from "./portal-nav";

/**
 * The frame every signed-in screen sits in.
 *
 * The header is a light bar carrying the ORGANIZATION on the left and the
 * 10XiD mark on the right, rather than a brand-coloured slab with the product
 * name in the corner. That is the right way round: on any given screen the
 * thing a person most needs to be sure of is whose data they are looking at —
 * staff move between clients all day — and 10XiD is the platform underneath,
 * not the subject of the page.
 *
 * The mark on the right is the account control: sign out, switch organization,
 * personal details. Muted, because it is the one thing on the bar that is
 * about you rather than about the work.
 */
export function PortalShell({
  children,
  email,
  isStaff,
  actingOn,
  organization,
}: {
  children: ReactNode;
  email: string;
  isStaff: boolean;
  actingOn: { name: string; reason: string } | null;
  /**
   * Whose screen this is. Optional for now: every caller passing it means
   * every page fetching it, and the pages are being reworked for Flow anyway.
   * When absent the platform name stands in, which is honest — it says "you
   * are in 10XiD" rather than naming the wrong company.
   *
   * While staff hold a grant, the client they are acting on wins, because that
   * is the organization whose rows are on screen.
   */
  organization?: { name: string; logoUrl: string | null } | null;
}) {
  const shown = actingOn
    ? { name: actingOn.name, logoUrl: organization?.logoUrl ?? null }
    : (organization ?? { name: "10XiD Portal", logoUrl: null });

  const links = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/jobs", label: "Jobs" },
    { href: "/team", label: "Team" },
    ...(isStaff
      ? [
          { href: "/staff", label: "Clients" },
          { href: "/staff/keys", label: "Keys" },
        ]
      : []),
  ];

  return (
    <div className="min-h-dvh bg-ground">
      <PortalHeader
        organizationName={shown.name}
        organizationLogoUrl={shown.logoUrl}
        email={email}
        links={links}
        menu={
          <>
            <a href="/account/sessions" className={menuItemClass}>
              Your details and devices
            </a>
            {isStaff ? (
              <a href="/staff" className={menuItemClass}>
                Switch organization
              </a>
            ) : null}
            <form action={signOutAction}>
              <button type="submit" className={menuItemClass}>
                Sign out
              </button>
            </form>
          </>
        }
      />

      {/*
        The acting-as banner is not decoration. Staff reach every client's data,
        and the single most likely mistake is forgetting which client you are
        looking at and editing the wrong one. It states the client and the
        reason that was typed, and stays put until the grant is given up.
      */}
      {actingOn ? (
        <div className="border-b border-warn/30 bg-warn/10">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2">
            <p className="text-sm text-ink">
              Acting on <strong>{actingOn.name}</strong> as staff
              <span className="text-ink-faint"> — {actingOn.reason}</span>
            </p>
            <form action={exitClientAction}>
              <button
                type="submit"
                className="rounded-md border border-line px-2.5 py-1 text-xs
                           font-medium text-ink-soft transition-colors
                           hover:bg-surface focus-visible:outline-2
                           focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Exit
              </button>
            </form>
          </div>
        </div>
      ) : null}

      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
