"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The header's behaviour, split out because it needs the browser.
 *
 * Two things live here that a server component cannot do: the bar hides as you
 * read down and comes back the moment you head up, and the account menu opens.
 * Everything the menu ACTS on is still a server action passed in as children —
 * signing out does not become a client concern just because the menu that holds
 * it is one.
 */

/**
 * Hide going down, reappear going up.
 *
 * Not a scroll position test — "am I past 100px" leaves the bar covering the
 * top of the page the whole way down. It is a DIRECTION test, so the bar is
 * gone while you are reading and back as soon as you reach for it.
 *
 * The 6px threshold is deliberate. Without it, the rubber-band overscroll on
 * iOS and a trackpad's settling jitter both flicker the bar several times a
 * second, which is worse than never hiding it at all.
 *
 * Always visible at the very top, so the first thing anybody sees on a fresh
 * page is the navigation rather than an empty strip.
 */
function useHideOnScrollDown() {
  const [visible, setVisible] = useState(true);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;

    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastY.current;
      if (Math.abs(delta) < 6) return;
      setVisible(delta < 0 || y < 64);
      lastY.current = y;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return visible;
}

export function PortalHeader({
  organizationName,
  organizationLogoUrl,
  email,
  links,
  menu,
}: {
  organizationName: string;
  organizationLogoUrl: string | null;
  email: string;
  links: { href: string; label: string }[];
  /** Sign out, and anything else that needs a server action. */
  menu: ReactNode;
}) {
  const visible = useHideOnScrollDown();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // A menu that only closes via its own button is a menu people leave open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-40 border-b border-line-soft bg-surface/95
                  backdrop-blur transition-transform duration-200
                  ${visible ? "translate-y-0" : "-translate-y-full"}`}
    >
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        {/*
          The organization, on the left, because the single most consequential
          thing a person can misread on this screen is WHOSE data they are
          looking at. Staff move between clients; the brand is the answer.
        */}
        <Link href="/dashboard" className="flex min-w-0 flex-none items-center gap-2.5">
          {organizationLogoUrl ? (
            /*
             * A plain <img>, deliberately. A client's logo is an arbitrary
             * remote URL, and next/image refuses any host not listed in
             * next.config — so every new client would need a deploy before
             * their own logo would appear. A 28px avatar is not worth that.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={organizationLogoUrl}
              alt=""
              className="h-7 w-7 flex-none rounded-md object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="grid h-7 w-7 flex-none place-items-center rounded-md
                         bg-brand text-[11px] font-bold text-white"
            >
              {organizationName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="truncate text-sm font-semibold text-ink">
            {organizationName}
          </span>
        </Link>

        {/*
          The nav scrolls sideways on a narrow screen, because six links do not
          fit on a phone and wrapping them would change the header's height as
          you move between pages.

          What it does NOT do any more is hide the scrollbar. The previous
          version set overflow-x-auto with no affordance, so on a phone the
          scrollbar drew straight through the middle of the link text, and on a
          desktop there was nothing at all to say more links existed. Now the
          track sits in its own space below the text (pb-2 -mb-2), and it is
          thin and tinted rather than the browser's default slab.
        */}
        <nav
          aria-label="Sections"
          className="portal-nav-scroll -mb-2 flex min-w-0 flex-1 items-center gap-4
                     overflow-x-auto whitespace-nowrap pb-2 text-sm"
        >
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex-none text-ink-soft transition-colors hover:text-ink"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {/*
          The 10XiD mark is the account button, not decoration — it is where you
          sign out, change organization, and find your own details. Muted,
          because it is the one control on this bar that is about YOU rather
          than about the work.
        */}
        <div ref={wrap} className="relative flex-none">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label="Account and organization"
            className="grid h-9 w-9 place-items-center rounded-lg border border-line
                       text-[10px] font-bold tracking-tight text-ink-faint
                       transition-colors hover:border-ink-faint hover:text-ink-soft
                       focus-visible:outline-2 focus-visible:outline-offset-2
                       focus-visible:outline-brand"
          >
            10<span className="text-ink-soft">X</span>iD
          </button>

          {open ? (
            <div
              role="menu"
              className="absolute right-0 top-11 w-60 overflow-hidden rounded-xl
                         border border-line bg-surface shadow-card-lg"
            >
              <div className="border-b border-line-soft px-3 py-2.5">
                <p className="truncate text-sm font-medium text-ink">{email}</p>
                <p className="truncate text-xs text-ink-faint">{organizationName}</p>
              </div>
              <div className="py-1">{menu}</div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/** One row in the account menu. Shared so every item lines up. */
export const menuItemClass =
  "block w-full px-3 py-2 text-left text-sm text-ink-soft transition-colors " +
  "hover:bg-sunk hover:text-ink";
