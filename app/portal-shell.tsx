import type { ReactNode } from "react";
import { getSessionContext } from "@/lib/auth/session";
import { signOutAction, signOutEverywhereAction } from "./sign-out";
import { loginOrigin } from "@/lib/auth/origin";
import { CsrfField } from "./_components/csrf-field";
import { exitClientAction } from "./staff/actions";
import { PortalHeader, menuItemClass } from "./portal-nav";
import { mayUseChatBoss } from "@/lib/auth/chat-boss";
import { openableBusinesses } from "@/lib/auth/policy";
import { ROLE_LABELS, isRoleTemplate } from "@/lib/auth/permissions";

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
  const ctx = await getSessionContext();

  /**
   * The business on screen, from the session, when the page did not name
   * one: with the business switcher a person can belong to several, and the
   * mark is how they know which one they are in.
   */
  const clientBusinesses = ctx ? openableBusinesses(ctx.memberships, ctx.agencyAccess) : [];
  const onScreen = clientBusinesses.find((m) => m.organizationId === ctx?.scope.organizationId);
  const onScreenMembership = ctx?.memberships.find((m) => m.organizationId === ctx.scope.organizationId);
  const shown = actingOn
    ? { name: actingOn.name, logoUrl: organization?.logoUrl ?? null }
    : (organization ??
      (onScreen ? { name: onScreen.organizationName, logoUrl: null } : { name: "10XiD Portal", logoUrl: null }));

  const links = [
    // First for staff because it is where sign-in lands them.
    ...(isStaff ? [{ href: "/chat", label: "Chat" }] : []),
    { href: "/dashboard", label: "Dashboard" },
    { href: "/jobs", label: "Jobs" },
    { href: "/team", label: "Team" },
    // Agency: an agency's owners and managers, with the agency open.
    ...(onScreenMembership?.organizationIsAgency &&
    (onScreenMembership.role === "owner" || onScreenMembership.role === "manager")
      ? [{ href: "/agency", label: "Agency" }]
      : []),
    // Chat Boss: the people on its list, on the business they have open.
    ...(!isStaff && ctx && ctx.scope.organizationId && mayUseChatBoss(ctx.email)
      ? [{ href: "/chat", label: "Chat Boss" }]
      : []),
    ...(isStaff
      ? [
          { href: "/staff", label: "Clients" },
          { href: "/staff/keys", label: "Keys" },
        ]
      : []),
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
            ) : clientBusinesses.length > 1 ? (
              <a href="/business" className={menuItemClass}>
                Switch business
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
            {/* Sessions, authenticator and recovery codes live on the login host. */}
            <a href={`${loginOrigin() ?? ""}/auth/account`} className={menuItemClass}>
              Sign-in &amp; security
            </a>
            <form action={signOutAction}>
              <CsrfField />
              <button type="submit" className={menuItemClass}>
                Sign out
              </button>
            </form>
            <form action={signOutEverywhereAction}>
              <CsrfField />
              <button type="submit" className={menuItemClass}>
                Sign out everywhere
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

      {/*
        Working in somebody else's business through agency access: always said,
        on every page, with the agency, the role and the end date, so nobody
        forgets whose records these are.
      */}
      {onScreen?.via ? (
        <div className="border-b border-brand/30 bg-brand/5" role="status">
          <p className="mx-auto max-w-5xl px-4 py-2 text-sm text-ink">
            Working in <span className="font-semibold">{onScreen.organizationName}</span> for{" "}
            {onScreen.via.agencyName} · {isRoleTemplate(onScreen.role) ? ROLE_LABELS[onScreen.role] : onScreen.role} · until {onScreen.via.expiresAt.toISOString().slice(0, 10)}
          </p>
        </div>
      ) : null}

      <main className={wide ? "min-h-0 flex-1" : "mx-auto max-w-5xl px-4 py-8"}>{children}</main>
    </div>
  );
}
