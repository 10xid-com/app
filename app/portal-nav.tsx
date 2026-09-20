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

/**
 * Watch a scrolling strip and report where it is.
 *
 * Needed because the browser's own scrollbar cannot do this job here. On iOS
 * and on modern macOS the scrollbar is an OVERLAY: it fades in while a scroll
 * is in progress and disappears again a moment later. At rest — which is how a
 * page looks when you arrive on it — there is nothing on screen to say the
 * strip scrolls at all, so the links past the fold may as well not be rendered.
 * `scrollbar-width: thin` does not change that; it styles a bar that is still
 * only drawn during a scroll.
 *
 * So the bar is drawn by hand from these numbers instead, and it is always
 * there while there is anything to scroll to.
 *
 * Returns fractions rather than pixels, so the caller can lay the thumb out in
 * percentages and never has to re-measure on a resize.
 *
 * The ref comes back as its own value rather than a key on the returned
 * object, which is not a style choice: react-hooks/refs treats any object
 * holding a `ref` property as a ref itself, and then reads every other field
 * off it as an access to `.current` during render. A tuple keeps the numbers
 * plainly numbers.
 */
function useScrollTrack(
  deps: unknown,
): [
  React.RefObject<HTMLElement | null>,
  {
    overflowing: boolean;
    size: number;
    start: number;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  },
] {
  const ref = useRef<HTMLElement>(null);
  const [track, setTrack] = useState({ overflowing: false, size: 1, start: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const { scrollWidth, clientWidth, scrollLeft } = el;
      const hidden = scrollWidth - clientWidth;

      // A fraction of a pixel of overflow is a rounding artefact, not content.
      if (hidden <= 1) {
        setTrack({ overflowing: false, size: 1, start: 0 });
        return;
      }

      /*
       * The thumb is as wide a share of the track as the visible strip is of
       * the whole strip — but never narrower than an eighth, or with enough
       * links it becomes a speck nobody can see or grab.
       *
       * Once that floor is in play the thumb no longer travels the full track,
       * so its position is the scroll PROGRESS (0 to 1) across whatever travel
       * is left. Using scrollLeft/scrollWidth instead would run the thumb off
       * the end of the track at the last link.
       */
      const size = Math.max(clientWidth / scrollWidth, 0.125);
      const progress = scrollLeft / hidden;
      setTrack({ overflowing: true, size, start: progress * (1 - size) });
    };

    measure();
    el.addEventListener("scroll", measure, { passive: true });

    // Catches the bar getting narrower, and the links changing with it.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);

    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [deps]);

  /**
   * Drag the thumb, or tap anywhere on the track to jump there.
   *
   * Pointer events rather than mouse events, so a finger and a trackpad take
   * the same path, and pointer capture so the drag survives the pointer
   * leaving a 3px-tall target — which it will, immediately.
   */
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const hidden = el.scrollWidth - el.clientWidth;

    const scrollTo = (clientX: number) => {
      // Centre the visible strip on the pointer, which is what makes a tap on
      // the track land where the eye expects rather than one strip-width off.
      const fraction = (clientX - rect.left) / rect.width;
      el.scrollLeft = Math.min(hidden, Math.max(0, fraction * el.scrollWidth - el.clientWidth / 2));
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    scrollTo(event.clientX);

    const onMove = (e: PointerEvent) => scrollTo(e.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return [ref, { ...track, onPointerDown }];
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
  const [stripRef, strip] = useScrollTrack(links.length);
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
      {/*
        Three zones, and the measurements are the house iD's, not invented here.

        The reference iD (preview.10xid.com/id/10xid/) sizes its header off two
        tokens: --markbox-client 80px for the Mark and --markbox 68px for the
        Pin, dropping to 66/56 under 360px. Both tiers hold the same 0.85 ratio,
        and 48/41 is that same ratio at a third tier. It is smaller than either
        of theirs on purpose: their header is a card's masthead that stacks its
        nav onto a SECOND row, while this one is a sticky bar that has to carry
        Mark, nav and Pin across a single line on a 390px phone. Everything else
        here — radii, pill geometry, type scale — is the reference's own value
        rather than a scaled one.

        The first version put 40px icons in this 64px bar and took the
        reference's --pad of 12px above and below. That is the right proportion
        for a masthead with room to breathe and the wrong one for a phone: 12px
        of nothing at the top, 12px at the bottom and 16px at the screen edge
        added up to more empty bar than Mark. Reported from a phone as "too
        much top, bottom and outside margin".

        48px leaves 8px above and below, and the side padding drops to 8px
        below the sm breakpoint. Neither artwork carries any padding of its own
        — both PNGs are 256x256 edge to edge, measured — so every pixel of
        space around them is set here and nowhere else.
      */}
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-2 px-2 sm:px-4">
        {/*
          LEFT — the Mark. Full colour, never muted, because the Mark IS the
          organization: on any given screen the most consequential thing a
          person can misread is whose data they are looking at, and staff move
          between clients all day.

          What was here before was a two-letter tile drawn in CSS on bg-brand.
          That is not a Mark; it is a placeholder wearing the platform's colour,
          which told a client their own brand was ours. The Mark slot now always
          holds real artwork.

          The fallback is the 10XiD Mark itself rather than initials. When an
          organization has no logo, the honest answer is the one PortalShell
          already gives for the NAME — you are in 10XiD — so the graphic says
          the same thing the words do instead of inventing a brand that has
          never existed.

          A plain <img>, deliberately, and for the same reason it was one
          before: a client's logo is an arbitrary remote URL and next/image
          refuses any host not listed in next.config, so every new client would
          need a deploy before their own logo appeared. Keeping the local
          fallback on the same element keeps that one code path rather than
          branching into an <Image> that only ever serves one file.

          object-contain, not object-cover: a logo cropped to a square is a
          logo with its edges cut off. object-left keeps it anchored the way
          the reference's .mark--img does (object-position: left center).

          The corner radius is 5px and that number is measured, not chosen.
          /10xid-mark.png is 256x256 with NO transparent padding at all, and
          its own rounded-square plate starts 27px in along the top edge — a
          radius of about 10.5% of the box. An earlier version clipped this
          element at rounded-[14px] on a 40px box, which is 35%, over three
          times the artwork's own. The container was therefore cutting a
          rounder shape than the plate it contained, slicing the corners off
          the blue square and leaving something that read as a circle rather
          than a mark. Reported from a phone: "you seem to have them in
          circles or something, the Mark does not show clearly."

          10.5% of a 48px box is 5.06px, so 5px is just under the artwork's
          own and clips none of it, while still softening a client logo that
          arrives as a bare rectangle. The rule to keep: this radius must stay
          at or below the radius of the artwork inside it.
        */}
        <Link
          href="/dashboard"
          className="flex min-w-0 flex-none items-center gap-2
                     transition active:brightness-110"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={organizationLogoUrl ?? "/10xid-mark.png"}
            alt={organizationName}
            className="h-12 w-12 flex-none rounded-[5px] object-contain object-left"
          />
          {/*
            The name is the Mark's caption, and it steps aside under 640px. On a
            phone the three fixed items already eat 122px of a 390px bar, and
            leaving the name in shrinks the nav to a link and a half. The Mark
            is by definition the identity of whoever owns the iD, so it carries
            that on its own at phone width, and the account menu spells the
            organization out in words for anyone who wants it confirmed.

            17px / 650 / -0.01em is the reference's .ident h1 exactly.
          */}
          <span
            className="hidden truncate text-[17px] font-[650] tracking-[-0.01em]
                       text-ink sm:block"
          >
            {organizationName}
          </span>
        </Link>

        {/*
          CENTRE — moving around inside the organization. Same links as before;
          what changed is that they are now the reference's .hnav pills rather
          than bare text: 7px/13px padding, a 999px radius, 13px at weight 520,
          on a plate a step off the bar with a hairline border.

          The nav scrolls sideways on a narrow screen, because six links do not
          fit on a phone and wrapping them would change the header's height as
          you move between pages.

          What it does NOT do is hide the scrollbar. An earlier version set
          overflow-x-auto with no affordance, so on a phone the scrollbar drew
          straight through the middle of the link text, and on a desktop there
          was nothing at all to say more links existed. The track sits in its
          own space below the pills (pb-2 -mb-2), and it is thin and tinted
          rather than the browser's default slab — see .portal-nav-scroll.
        */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <nav
            ref={stripRef}
            aria-label="Sections"
            className="portal-nav-scroll flex items-center gap-2
                       overflow-x-auto whitespace-nowrap"
          >
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="flex-none rounded-full border border-line-soft bg-sunk
                           px-[13px] py-[7px] text-[13px] font-[520] text-ink
                           transition-colors hover:border-line hover:bg-brand-soft"
              >
                {l.label}
              </Link>
            ))}
          </nav>

          {/*
            The scrollbar, drawn rather than left to the browser.

            It is hidden when everything fits, because a full-width bar under a
            strip that does not scroll is a control that does nothing.

            aria-hidden, and that is deliberate rather than an oversight. This
            is a redundant POINTER affordance: a keyboard user tabs through the
            pills and the browser scrolls each one into view on focus, which is
            the accessible path and works whether this bar exists or not.
            Announcing a second scroll control to a screen reader would add a
            thing to get past, not a thing to use.

            The hit area is 14px tall while the bar itself is 3px, because a
            3px drag target is a target nobody hits. The padding does the work
            and the negative margin gives the height back to the bar.
          */}
          {strip.overflowing ? (
            <div
              aria-hidden
              onPointerDown={strip.onPointerDown}
              className="-my-[5.5px] cursor-pointer touch-none py-[5.5px]"
            >
              <div className="h-[3px] w-full rounded-full bg-line-soft">
                <div
                  className="h-full rounded-full bg-ink-faint"
                  style={{
                    width: `${strip.size * 100}%`,
                    marginLeft: `${strip.start * 100}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>

        {/*
          RIGHT — the Pin. It opens the account menu: personal details, switch
          organization, sign out.

          A Pin is the quiet one. It is muted and tinted toward the Mark's
          colours so it never competes with the Mark for the eye, which is the
          whole reason it can sit on the same bar as a full-colour logo without
          the bar looking like it has two owners.

          The text "10XiD" in a bordered box that used to be here was the wrong
          object twice over: it was louder than the Mark, and spelling the
          product name out at the account control said the bar belonged to the
          platform rather than to the client.

          The button is bare — no border, matching the reference's .ubtn, which
          is background:transparent/border:0 at a 10px radius. The glyph already
          carries a rounded-square outline of its own; a second box around it is
          a box around a box. The hover plate is the same move the reference
          makes on its own muted icon buttons (.sheetnav:active, a faint wash).

          The mask lives on the inner span, not the button: a mask clips
          everything an element paints, focus ring included. See .portal-pin.
        */}
        <div ref={wrap} className="relative flex-none">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label="Account and organization"
            className="grid h-12 w-12 place-items-center rounded-[10px]
                       transition-colors hover:bg-sunk
                       focus-visible:outline-2 focus-visible:outline-offset-2
                       focus-visible:outline-brand"
          >
            <span aria-hidden className="portal-pin block h-[41px] w-[41px]" />
          </button>

          {open ? (
            <div
              role="menu"
              className="absolute right-0 top-12 w-60 overflow-hidden rounded-[14px]
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

/**
 * One row in the account menu. Shared so every item lines up.
 *
 * 14.5px at weight 530 is the reference's own list-row type (.sheet .links),
 * which is a touch larger and a touch lighter than text-sm/font-medium would
 * give — these are rows you read once and tap, not dense table text.
 */
export const menuItemClass =
  "block w-full px-3 py-2 text-[14.5px] font-[530] text-left text-ink-soft " +
  "transition-colors hover:bg-sunk hover:text-ink";
