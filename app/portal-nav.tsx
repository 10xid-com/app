"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./_components/icons";
import type { NavLink } from "./_components/sections";

/**
 * The frame's behaviour, split out because it needs the browser.
 *
 * Three columns, from Paolo's sketch of 2026-10-08: the navigation on the
 * left, the page in the middle, Chat Boss on the right. Either side column
 * folds away, and the choice is remembered (a cookie the server reads, so a
 * folded column is drawn folded rather than flashing open first).
 *
 * Below 1024px the navigation is a drawer, and below 1280px so is Chat Boss:
 * three columns do not fit a laptop with the page still readable, and the page
 * is the thing a person came for. Drawers always start closed, whatever the
 * cookie says; it is about the wide layout.
 *
 * Everything the account menu ACTS on is still a server action passed in as
 * children — signing out does not become a client concern just because the
 * menu that holds it is one.
 */

export type NavGroup = {
  /** A heading over the group, linking somewhere when `href` is given. */
  title?: { label: string; href: string };
  links: NavLink[];
};

const NAV_COOKIE = "portal_nav";
const CHAT_COOKIE = "portal_chat";
const WIDE_NAV = "(min-width: 1024px)";
const WIDE_CHAT = "(min-width: 1280px)";

/** A layout preference, not a secret: readable by the page, a year long. */
function remember(name: string, open: boolean) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${open ? "open" : "closed"}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

const wide = (query: string) => window.matchMedia(query).matches;

/** For Chat Boss's own close button, which lives inside the panel it closes. */
const ChatPanelContext = createContext<{ close: () => void }>({ close: () => {} });
export const useChatPanel = () => useContext(ChatPanelContext);

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PortalFrame({
  organizationName,
  organizationLogoUrl,
  email,
  groups,
  menu,
  banners,
  chat,
  navOpenInitially,
  chatOpenInitially,
  wide: wideMain,
  children,
}: {
  organizationName: string;
  organizationLogoUrl: string | null;
  email: string;
  groups: { main: NavGroup[]; foot: NavLink[] };
  /** Sign out, and anything else that needs a server action. */
  menu: ReactNode;
  /** Acting-as and agency notices: above the page, on every page. */
  banners: ReactNode;
  /** The Chat Boss panel, or null where the page itself is Chat Boss. */
  chat: ReactNode | null;
  navOpenInitially: boolean;
  chatOpenInitially: boolean;
  /** The page fills the column edge to edge (the workspace) instead of a reading column. */
  wide: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(navOpenInitially);
  const [navDrawer, setNavDrawer] = useState(false);
  const [chatOpen, setChatOpen] = useState(chatOpenInitially);
  const [chatDrawer, setChatDrawer] = useState(false);

  // What the top bar names: the deepest link this page sits under. A group's
  // own heading comes first, so /channels reads "Channels" rather than its
  // "Add channel" row.
  const current = useMemo(() => {
    const titles = groups.main.flatMap((g) =>
      g.title ? [{ href: g.title.href, label: g.title.label, icon: "channels" as const }] : [],
    );
    return [...titles, ...groups.main.flatMap((g) => g.links), ...groups.foot]
      .filter((l) => isActive(pathname, l.href))
      .sort((a, b) => b.href.length - a.href.length)[0];
  }, [groups, pathname]);

  // Escape closes whichever drawer is open; the wide columns stay as they are.
  useEffect(() => {
    if (!navDrawer && !chatDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setNavDrawer(false);
      setChatDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navDrawer, chatDrawer]);

  const showNav = () => {
    if (wide(WIDE_NAV)) {
      setNavOpen(true);
      remember(NAV_COOKIE, true);
    } else setNavDrawer(true);
  };
  const hideNav = () => {
    if (wide(WIDE_NAV)) {
      setNavOpen(false);
      remember(NAV_COOKIE, false);
    }
    setNavDrawer(false);
  };
  const openChat = () => {
    if (wide(WIDE_CHAT)) {
      setChatOpen(true);
      remember(CHAT_COOKIE, true);
    } else setChatDrawer(true);
  };
  // Memoised so the panel's context does not change on every render of the frame.
  const chatPanel = useMemo(
    () => ({
      close: () => {
        if (wide(WIDE_CHAT)) {
          setChatOpen(false);
          remember(CHAT_COOKIE, false);
        }
        setChatDrawer(false);
      },
    }),
    [],
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-ground">
      {/* LEFT — the navigation. A column when wide and open, a drawer below 1024px. */}
      <aside
        aria-label="Navigation"
        className={`${navDrawer ? "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] shadow-card-lg" : "hidden"}
                    ${navOpen ? "lg:static lg:z-auto lg:flex lg:w-60 lg:max-w-none lg:shadow-none" : "lg:hidden"}
                    flex-none flex-col border-r border-line-soft bg-sunk`}
      >
        <Sidebar
          groups={groups}
          pathname={pathname}
          organizationName={organizationName}
          organizationLogoUrl={organizationLogoUrl}
          email={email}
          menu={menu}
          onHide={hideNav}
          onNavigate={() => setNavDrawer(false)}
        />
      </aside>

      {/* CENTRE — the page. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 flex-none items-center gap-2 border-b border-line-soft bg-ground px-3 sm:px-4">
          <button
            type="button"
            onClick={showNav}
            aria-label="Show navigation"
            aria-expanded={navDrawer}
            className={`${navOpen ? "lg:hidden" : ""} grid h-9 w-9 flex-none place-items-center rounded-lg
                        text-ink-soft transition-colors hover:bg-sunk hover:text-ink
                        focus-visible:outline-2 focus-visible:outline-brand`}
          >
            <Icon name="sidebar-left" />
          </button>
          {/* The Mark again on a narrow screen, where the sidebar that carries it is folded away. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={organizationLogoUrl ?? "/10xid-mark.png"}
            alt=""
            className="h-7 w-7 flex-none rounded-[3px] object-contain lg:hidden"
          />
          <p className="flex min-w-0 flex-1 items-center gap-2 text-[15px] font-[600] text-ink">
            {current ? <Icon name={current.icon} className="hidden h-[18px] w-[18px] text-ink-soft sm:block" /> : null}
            <span className="truncate">{current?.label ?? organizationName}</span>
          </p>
          <Link
            href="/channels/id"
            className="flex flex-none items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5
                       text-[13px] font-[560] text-ink shadow-card transition-colors hover:bg-sunk"
          >
            <Icon name="eye" className="h-4 w-4" />
            Preview iD
          </Link>
        </div>

        {banners}

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className={wideMain ? "h-full" : "mx-auto max-w-5xl px-4 pb-28 pt-8"}>{children}</div>
        </main>

        {/*
          "Work with Chat Boss": the way back to the panel once it is folded
          away, floating over the bottom of the page where the sketch put it.
          Gone whenever the panel itself is showing.
        */}
        {chat ? (
          <button
            type="button"
            onClick={openChat}
            className={`${chatOpen ? "xl:hidden" : ""} ${chatDrawer ? "hidden" : ""}
                        absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap
                        rounded-full border border-line bg-surface py-2 pl-4 pr-2 text-[14px] font-[600] text-ink
                        shadow-card-lg transition-colors hover:bg-sunk
                        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`}
          >
            Work with Chat Boss
            <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-surface text-brand-on-surface">
              <Icon name="sidebar-right" className="h-4 w-4" />
            </span>
          </button>
        ) : null}
      </div>

      {/* RIGHT — Chat Boss. A column when wide and open, a drawer below 1280px. */}
      {chat ? (
        <aside
          aria-label="Chat Boss"
          className={`${chatDrawer ? "fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] shadow-card-lg" : "hidden"}
                      ${chatOpen ? "xl:static xl:z-auto xl:flex xl:w-[380px] xl:max-w-none xl:shadow-none" : "xl:hidden"}
                      flex-none flex-col border-l border-line-soft bg-surface`}
        >
          <ChatPanelContext.Provider value={chatPanel}>{chat}</ChatPanelContext.Provider>
        </aside>
      ) : null}

      {navDrawer || chatDrawer ? (
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => {
            setNavDrawer(false);
            setChatDrawer(false);
          }}
          className={`fixed inset-0 z-40 bg-ink/30 ${navDrawer ? "lg:hidden" : "xl:hidden"}`}
        />
      ) : null}
    </div>
  );
}

function Sidebar({
  groups,
  pathname,
  organizationName,
  organizationLogoUrl,
  email,
  menu,
  onHide,
  onNavigate,
}: {
  groups: { main: NavGroup[]; foot: NavLink[] };
  pathname: string;
  organizationName: string;
  organizationLogoUrl: string | null;
  email: string;
  menu: ReactNode;
  onHide: () => void;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  /*
   * Search finds a screen by name. It is the honest scope for it today: most
   * sections have nothing in them yet, and a box that promised to search
   * orders and customers would find nothing in either.
   */
  const q = query.trim().toLowerCase();
  const found = q
    ? [...groups.main.flatMap((g) => g.links), ...groups.foot].filter((l) => l.label.toLowerCase().includes(q))
    : null;

  const go = () => {
    setQuery("");
    onNavigate();
  };

  return (
    <>
      {/*
        The top: the platform, quietly — the Pin in grey and the name beside
        it — and the button that folds the column away. The client's own Mark
        is at the foot, in colour, on the account button.
      */}
      <div className="flex h-14 flex-none items-center gap-2 px-3">
        <Link href="/dashboard" onClick={go} className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden className="portal-pin block h-7 w-7 flex-none" />
          <span className="text-[16px] font-[650] tracking-[-0.01em] text-ink">10XiD</span>
        </Link>
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide navigation"
          className="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink-soft transition-colors
                     hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Icon name="sidebar-left" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5
                          text-ink-faint focus-within:border-brand focus-within:outline-2 focus-within:outline-brand/30">
          <Icon name="search" className="h-4 w-4" />
          <span className="sr-only">Search</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && found?.[0]) {
                router.push(found[0].href);
                go();
              }
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
      </div>

      <nav aria-label="Sections" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {found ? (
          found.length ? (
            <ul className="space-y-0.5">
              {found.map((l) => (
                <li key={`${l.href} ${l.label}`}>
                  <NavItem link={l} active={isActive(pathname, l.href)} onClick={go} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-2 text-sm text-ink-faint">Nothing called “{query.trim()}”.</p>
          )
        ) : (
          groups.main.map((group, i) => (
            <div key={group.title?.label ?? i} className={i ? "mt-5" : ""}>
              {group.title ? (
                <Link
                  href={group.title.href}
                  onClick={go}
                  className="mb-1 flex items-center gap-1 rounded-md px-2.5 py-1 text-[12.5px] font-[600]
                             text-ink-soft transition-colors hover:text-ink"
                >
                  {group.title.label}
                  <Icon name="chevron-right" className="h-3.5 w-3.5" />
                </Link>
              ) : null}
              <ul className="space-y-0.5">
                {group.links.map((l) => (
                  <li key={`${l.href} ${l.label}`}>
                    <NavItem link={l} active={isActive(pathname, l.href)} onClick={go} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>

      <div className="flex-none border-t border-line-soft px-2 pb-2 pt-2">
        {found ? null : (
          <ul className="mb-2 space-y-0.5">
            {groups.foot.map((l) => (
              <li key={l.href}>
                <NavItem link={l} active={isActive(pathname, l.href)} onClick={go} />
              </li>
            ))}
          </ul>
        )}
        <AccountButton
          organizationName={organizationName}
          organizationLogoUrl={organizationLogoUrl}
          email={email}
          menu={menu}
        />
      </div>
    </>
  );
}

function NavItem({ link, active, onClick }: { link: NavLink; active: boolean; onClick: () => void }) {
  return (
    <Link
      href={link.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] transition-colors
                  ${active ? "bg-surface font-[600] text-ink shadow-card" : "font-[500] text-ink-soft hover:bg-surface/70 hover:text-ink"}`}
    >
      <Icon name={link.icon} className={`h-[18px] w-[18px] ${active ? "text-brand" : ""}`} />
      <span className="truncate">{link.label}</span>
    </Link>
  );
}

/**
 * "My 10XiD": the client's Mark, in full colour, and the account menu above it.
 *
 * The Mark is the identity of whoever owns the iD — the organization whose rows
 * are on screen — and it is never muted: the most consequential thing a person
 * can misread is whose data they are looking at. It falls back to the 10XiD
 * Mark when the organization has no logo, which says the same thing the name
 * does: you are in 10XiD.
 *
 * A plain <img>, deliberately: a client's logo is an arbitrary remote URL and
 * next/image refuses any host not listed in next.config. The 3px radius stays
 * at or below the artwork's own (the 10XiD Mark's plate is about 10.5% of its
 * box), so the container never clips a rounder shape than the plate inside it.
 */
function AccountButton({
  organizationName,
  organizationLogoUrl,
  email,
  menu,
}: {
  organizationName: string;
  organizationLogoUrl: string | null;
  email: string;
  menu: ReactNode;
}) {
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
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account and organization"
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors
                   hover:bg-surface focus-visible:outline-2 focus-visible:outline-brand"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={organizationLogoUrl ?? "/10xid-mark.png"}
          alt=""
          className="h-9 w-9 flex-none rounded-[3px] object-contain"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-[600] text-ink">{organizationName}</span>
          <span className="block truncate text-[12px] text-ink-faint">My 10XiD</span>
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-[14px]
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
  );
}

/**
 * One row in the account menu. Shared so every item lines up.
 *
 * 14.5px at weight 530 is the reference iD's own list-row type (.sheet .links):
 * rows you read once and tap, not dense table text.
 */
export const menuItemClass =
  "block w-full px-3 py-2 text-[14.5px] font-[530] text-left text-ink-soft " +
  "transition-colors hover:bg-sunk hover:text-ink";
