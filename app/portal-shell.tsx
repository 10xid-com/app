import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "./auth/actions";
import { exitClientAction } from "./staff/actions";

/**
 * The frame every signed-in screen sits in.
 *
 * Follows the conventions of the existing Rotary storefront's admin area — a
 * slim brand-coloured bar, a horizontal nav, a max-width content column — so
 * the portal reads as part of the same family.
 */
export function PortalShell({
  children,
  email,
  isStaff,
  actingOn,
}: {
  children: ReactNode;
  email: string;
  isStaff: boolean;
  actingOn: { name: string; reason: string } | null;
}) {
  return (
    <div className="min-h-dvh bg-ground">
      <header className="bg-brand text-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-6">
            <Link href="/jobs" className="flex-none text-sm font-semibold tracking-wide">
              10XiD Portal
            </Link>
            <nav className="flex items-center gap-4 text-sm text-white/70">
              <Link href="/jobs" className="transition-colors hover:text-white">
                Jobs
              </Link>
              {isStaff ? (
                <Link href="/staff" className="transition-colors hover:text-white">
                  Clients
                </Link>
              ) : null}
              <Link
                href="/account/sessions"
                className="transition-colors hover:text-white"
              >
                Sessions
              </Link>
            </nav>
          </div>
          <div className="flex flex-none items-center gap-3">
            <span className="hidden text-xs text-white/70 sm:inline">{email}</span>
            <form action={signOutAction}>
              <button
                type="submit"
                className="rounded-md border border-white/25 px-2.5 py-1 text-xs
                           font-medium transition-colors hover:bg-white/10
                           focus-visible:outline-2 focus-visible:outline-offset-2
                           focus-visible:outline-white"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

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
