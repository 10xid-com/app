import type { ReactNode } from "react";
import { getSessionContext } from "@/lib/auth/session";
import { signOutAction } from "./sign-out";
import { CsrfField } from "./_components/csrf-field";
import { exitClientAction } from "./staff/actions";
import { stopActingAsAction } from "./act-as/actions";
import { PortalHeader, menuItemClass } from "./portal-nav";

/**
 * The frame every signed-in screen sits in.
 *
 * The header is built the way an iD is built, and the two parts have names that
 * are worth getting right, because an earlier version of this file had them the
 * wrong way round and the markup followed it.
 *
 * The MARK is the full-colour icon on the LEFT, and it is the identity of
 * whoever owns the iD — here, the organization whose rows are on screen. It is
 * never muted. That is the right way round for this product: on any given
 * screen the thing a person most needs to be sure of is whose data they are
 * looking at, since staff move between clients all day, and 10XiD is the
 * platform underneath rather than the subject of the page.
 *
 * The PIN is the thing at the TOP RIGHT, and it is the account control: sign
 * out, switch organization, personal details. A Pin is deliberately quiet, and
 * it is GRAYSCALE — "the mark is in colour, the Pin is grayscale", the house
 * rule of 2026-09-19. The mark belongs to whoever the iD is for and arrives in
 * their colours; the Pin is our badge on someone else's card and stays out of
 * the way. A first pass tinted it with the Mark's own blue, which inverts the
 * point: a coloured Pin reads as part of the client's brand, and a grey one
 * cannot be mistaken for it. What it is also NOT is a second mark, nor the
 * product name set in a box; both shout over the mark that should own the bar.
 */
export async function PortalShell({
  children,
  email,
  isStaff,
  actingOn = null,
  organization,
  wide = false,
}: {
  children: ReactNode;
  /**
   * Full width, for the workspace's three panels. Every other screen keeps the
   * reading-width column.
   */
  wide?: boolean;
  email: string;
  isStaff: boolean;
  actingOn?: { name: string; reason: string } | null;
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

  /**
   * The act-as banner is resolved HERE rather than passed in as a prop.
   *
   * Every other thing in this header is handed down by the page, and the
   * acting-on-a-client banner above is one of them — six pages each fetch
   * their own grant. That is survivable for a banner that says which client's
   * rows you are reading. It is not survivable for one that says you are
   * somebody else: a page added next month that forgot the prop would render a
   * whole screen of another person's work with nothing on it saying so, and
   * the whole safety of the feature is that the screen always says so.
   *
   * So the shell asks. It costs one already-cached session read per render and
   * it cannot be forgotten, because there is no argument to leave out.
   */
  const ctx = await getSessionContext();
  const actingAs = ctx?.actingAs ?? null;

  const links = [
    // First for staff because it is where sign-in lands them.
    ...(isStaff ? [{ href: "/chat", label: "Chat" }] : []),
    { href: "/dashboard", label: "Dashboard" },
    { href: "/jobs", label: "Jobs" },
    { href: "/team", label: "Team" },
    ...(isStaff
      ? [
          { href: "/staff", label: "Clients" },
          { href: "/staff/keys", label: "Keys" },
        ]
      : []),
    // Reachable while acting as a client too, where `isStaff` is false — it is
    // the way back, so it cannot be behind the thing the grant takes away.
    ...(ctx?.realIsStaff ? [{ href: "/act-as", label: "Act as" }] : []),
  ];

  return (
    // Wide (the workspace) is exactly one screen tall, so its panels scroll
    // inside themselves and the composer is never pushed below the fold by
    // whatever banners happen to be showing above it.
    <div className={wide ? "flex h-dvh flex-col bg-ground" : "min-h-dvh bg-ground"}>
      <PortalHeader
        organizationName={shown.name}
        organizationLogoUrl={shown.logoUrl}
        email={email}
        links={links}
        menu={
          <>
            {isStaff ? (
              <a href="/staff" className={menuItemClass}>
                Switch organization
              </a>
            ) : null}
            {/*
              The index of the service, in the Pin rather than in the nav.

              It belongs to the quiet side of the bar: it is not somewhere you
              work, it is somewhere you go to find out where to work. Putting it
              in the nav would also cost a sixth pill on a 390px phone, which
              the centre strip does not have — see portal-nav.tsx.
            */}
            <a href="/pages" className={menuItemClass}>
              Pages
            </a>
            <form action={signOutAction}>
              <CsrfField />
              <button type="submit" className={menuItemClass}>
                Sign out
              </button>
            </form>
          </>
        }
      />

      {/*
        WHO YOU ARE RIGHT NOW.

        Loud on purpose, and louder than the client banner below it. Paolo runs
        two browser profiles side by side as two different people; the failure
        this is sized against is not "which client is this" but "which WINDOW is
        this", and typing a reply to a client into the client's own account is
        not a mistake that announces itself afterwards. So: full-width, the
        strongest colour in the palette rather than a tint of it, the person's
        name at the top of the type scale, and an exit that is a real button
        sitting next to it.

        role="status" rather than role="alert": it is a standing condition, and
        an assertive live region would interrupt a screen reader on every
        single navigation for an hour.
      */}
      {actingAs ? (
        <div className="border-b-2 border-bad bg-bad text-white" role="status">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="min-w-0 text-base font-semibold leading-tight">
              <span className="uppercase tracking-wide opacity-90">
                You are acting as{" "}
              </span>
              <span className="text-lg font-bold">
                {actingAs.fullName ?? actingAs.email}
              </span>
              <span className="block truncate text-xs font-normal opacity-90">
                {actingAs.email} — {actingAs.reason} — until{" "}
                {actingAs.expiresAt.toISOString().slice(11, 16)} UTC
              </span>
            </p>
            <form action={stopActingAsAction} className="flex-none">
              <CsrfField />
              <button
                type="submit"
                className="rounded-md bg-white px-3 py-1.5 text-sm font-semibold
                           text-bad transition-opacity hover:opacity-90
                           focus-visible:outline-2 focus-visible:outline-offset-2
                           focus-visible:outline-white"
              >
                Stop acting as {actingAs.fullName ?? actingAs.email}
              </button>
            </form>
          </div>
        </div>
      ) : null}

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
              <CsrfField />
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

      <main className={wide ? "min-h-0 flex-1" : "mx-auto max-w-5xl px-4 py-8"}>{children}</main>
    </div>
  );
}
