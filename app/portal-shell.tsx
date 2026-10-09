import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getSessionContext, resolveIdentity, type SessionContext } from "@/lib/auth/session";
import { signOutAction, signOutEverywhereAction } from "./sign-out";
import { loginOrigin } from "@/lib/auth/origin";
import { CsrfField } from "./_components/csrf-field";
import { exitClientAction } from "./staff/actions";
import { PortalFrame, menuItemClass, type NavGroup } from "./portal-nav";
import { ChatDock, type ChatDockData } from "./chat/dock";
import { CHANNELS, ID_CHANNEL, SOON, type NavLink } from "./_components/sections";
import { openableBusinesses } from "@/lib/auth/policy";
import { ROLE_LABELS, isRoleTemplate } from "@/lib/auth/permissions";
import { organizationById } from "@/lib/db/identity";
import { listConversations, listMessages, listRuns, withheldEngineModes } from "@/lib/db/workspace";
import { blogDraftFrom } from "@/lib/workspace/blog-draft";
import { modeOptions } from "@/lib/ai/engine/registry";
import { listLinkedRepositories } from "@/lib/db/repositories";
import { githubApp } from "@/lib/repo";
import { websiteFor } from "@/lib/db/sites";
import { connectedChannels, type ConnectedChannel } from "@/lib/db/channels";
import { workspaceAccess } from "@/lib/workspace/access";

/**
 * The frame every signed-in screen sits in: the navigation on the left, the
 * page in the middle, Chat Boss on the right (Paolo's sketch of 2026-10-08).
 *
 * Two marks are on it, and they are worth getting right, because an earlier
 * version of the header had them the wrong way round and the markup followed.
 *
 * The MARK is the organization's own logo, in full colour, and it is the
 * identity of whoever owns the iD — the organization whose rows are on screen.
 * It is never muted: the thing a person most needs to be sure of is whose data
 * they are looking at. It sits on "My 10XiD" at the foot of the navigation,
 * which is also the account control (sign out, switch business), and again in
 * the top bar on a narrow screen where the navigation is folded away.
 *
 * The PIN is 10XiD's own, at the top of the navigation beside the product
 * name, and it is GRAYSCALE — "the mark is in colour, the Pin is grayscale",
 * the house rule of 2026-09-19. The Pin is our badge on someone else's card: a
 * coloured one would read as part of the client's brand, and a grey one cannot
 * be mistaken for it.
 */
export async function PortalShell({
  children,
  email,
  isStaff,
  actingOn = null,
  organization,
  wide = false,
  chatPanel = true,
}: {
  children: ReactNode;
  /**
   * Full width, for the workspace's three panels. Every other screen keeps the
   * reading-width column.
   */
  wide?: boolean;
  /**
   * Chat Boss beside the page. Every screen has it but /chat, where the page
   * itself is Chat Boss.
   */
  chatPanel?: boolean;
  email: string;
  isStaff: boolean;
  actingOn?: { name: string; reason: string } | null;
  /**
   * Whose screen this is. When absent it is read from the business the session
   * has open, and failing that the platform name stands in, which is honest —
   * it says "you are in 10XiD" rather than naming the wrong company.
   *
   * While staff hold a grant, the client they are acting on wins, because that
   * is the organization whose rows are on screen.
   */
  organization?: { name: string; logoUrl: string | null } | null;
}) {
  const ctx = await getSessionContext();

  /*
   * The business on screen, from the session, when the page did not name
   * one: with the business switcher a person can belong to several, and the
   * mark is how they know which one they are in.
   */
  const clientBusinesses = ctx ? openableBusinesses(ctx.memberships, ctx.agencyAccess) : [];
  const onScreen = clientBusinesses.find((m) => m.organizationId === ctx?.scope.organizationId);
  const onScreenMembership = ctx?.memberships.find((m) => m.organizationId === ctx.scope.organizationId);
  const onScreenOrg = !organization && onScreen ? await organizationById(onScreen.organizationId) : null;
  const shown = actingOn
    ? { name: actingOn.name, logoUrl: organization?.logoUrl ?? null }
    : (organization ??
      (onScreen
        ? { name: onScreen.organizationName, logoUrl: onScreenOrg?.brandLogoUrl ?? null }
        : { name: "10XiD Portal", logoUrl: null }));

  // The sidebar lists the channels this business has connected; Add channel
  // (/channels) offers the rest.
  const connected: Set<ConnectedChannel> =
    ctx && onScreen ? await connectedChannels({ organizationId: onScreen.organizationId, userId: ctx.userId }) : new Set();
  const channelLinks = (["website", "instagram", "facebook"] as const).filter((c) => connected.has(c)).map((c) => CHANNELS[c]);

  const main: NavGroup[] = [
    {
      links: [
        { href: "/dashboard", label: "Home", icon: "home" } satisfies NavLink,
        SOON.orders,
        { href: "/jobs", label: "Jobs", icon: "jobs" } satisfies NavLink,
        SOON.products,
        SOON.customers,
        SOON.growth,
        SOON.discounts,
        SOON.content,
        SOON.markets,
        SOON.finance,
        SOON.analytics,
      ].map(link),
    },
    {
      title: { label: "Channels", href: SOON.channels.href },
      links: [
        ID_CHANNEL,
        ...channelLinks,
        { href: SOON.channels.href, label: "Add channel", icon: "plus" } satisfies NavLink,
      ].map(link),
    },
  ];

  const foot: NavLink[] = [
    { href: "/team", label: "Team", icon: "team" as const },
    // Agency: an agency's owners and managers, with the agency open.
    ...(onScreenMembership?.organizationIsAgency &&
    (onScreenMembership.role === "owner" || onScreenMembership.role === "manager")
      ? [{ href: "/agency", label: "Agency", icon: "agency" as const }]
      : []),
    ...(isStaff
      ? [
          { href: "/chat", label: "Chat", icon: "chat" as const },
          { href: "/staff", label: "Clients", icon: "clients" as const },
          { href: "/staff/keys", label: "Keys", icon: "keys" as const },
        ]
      : []),
    link(SOON.settings),
  ];

  const layout = await cookies();

  return (
    <PortalFrame
      organizationName={shown.name}
      organizationLogoUrl={shown.logoUrl}
      email={email}
      groups={{ main, foot }}
      navOpenInitially={layout.get("portal_nav")?.value !== "closed"}
      chatOpenInitially={layout.get("portal_chat")?.value !== "closed"}
      wide={wide}
      chat={chatPanel ? <ChatDock data={await chatDockData(ctx)} /> : null}
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
            The index of the service. Not somewhere you work, somewhere you go
            to find out where to work, so it is on the quiet side with the
            account rather than in the sections.
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
      banners={
        <>
          {/*
            The acting-as banner is not decoration. Staff reach every client's
            data, and the single most likely mistake is forgetting which client
            you are looking at and editing the wrong one. It states the client
            and the reason that was typed, and stays put until the grant is
            given up.
          */}
          {actingOn ? (
            <div className="flex-none border-b border-warn/30 bg-warn/10">
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
            Working in somebody else's business through agency access: always
            said, on every page, with the agency, the role and the end date, so
            nobody forgets whose records these are.
          */}
          {onScreen?.via ? (
            <div className="flex-none border-b border-brand/30 bg-brand/5" role="status">
              <p className="mx-auto max-w-5xl px-4 py-2 text-sm text-ink">
                Working in <span className="font-semibold">{onScreen.organizationName}</span> for{" "}
                {onScreen.via.agencyName} ·{" "}
                {isRoleTemplate(onScreen.role) ? ROLE_LABELS[onScreen.role] : onScreen.role} · until {onScreen.via.expiresAt.toISOString().slice(0, 10)}
              </p>
            </div>
          ) : null}
        </>
      }
    >
      {children}
    </PortalFrame>
  );
}

/** Just the parts the nav draws: the placeholders' copy stays on the server. */
function link({ href, label, icon }: NavLink): NavLink {
  return { href, label, icon };
}

/** How much of the conversation the panel carries; the rest is in the workspace. */
const DOCK_MESSAGES = 30;

/**
 * What the Chat Boss panel shows. The same checks as /chat, through the same
 * function (lib/workspace/access.ts): the Chat Boss list, a business open, a
 * live client business. Anybody else gets the panel saying it is off, and none
 * of the business's conversations.
 */
async function chatDockData(ctx: SessionContext | null): Promise<ChatDockData> {
  const access = await workspaceAccess(ctx);
  if (!access) return { state: "off" };
  const identity = await resolveIdentity();
  const csrf = identity.state === "active" ? identity.csrfToken : "";

  const [latest] = await listConversations(access.owner, 1);
  if (!latest) {
    return { state: "on", csrf, businessName: access.client.name, conversation: null, messages: [], earlier: 0, website: null };
  }
  const [messages, withheld, runs, linked, site] = await Promise.all([
    listMessages(access.owner, latest.id),
    withheldEngineModes(access.owner),
    listRuns(access.owner, latest.id),
    listLinkedRepositories(access.owner),
    websiteFor(access.owner),
  ]);
  const siteRepo = site?.repositoryId ? linked.find((r) => r.id === site.repositoryId) : undefined;
  const current = latest.repositoryId ? linked.find((r) => r.id === latest.repositoryId) : undefined;
  // Blog posts Chat Boss proposed, as cards under the answers that proposed them.
  const draftsByRun = new Map(
    runs.map((r) => [r.id, r.receipts.flatMap((x) => blogDraftFrom({ id: x.id, detail: x.detail }) ?? [])]),
  );
  const engine = modeOptions(withheld, latest.engineMode).find((e) => e.id === latest.engineMode);
  const recent = messages.slice(-DOCK_MESSAGES);

  return {
    state: "on",
    csrf,
    businessName: access.client.name,
    conversation: {
      id: latest.id,
      title: latest.title,
      engine: engine ? { label: engine.label, available: engine.available, reason: engine.reason } : null,
      repository: current ? { id: current.id, name: `${current.owner}/${current.name}`, branch: latest.branch ?? current.defaultBranch } : null,
    },
    messages: recent.map((m) => ({
      id: m.id,
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
      status: m.status,
      drafts: m.runId ? (draftsByRun.get(m.runId) ?? []) : [],
    })),
    earlier: messages.length - recent.length,
    // For the "+" menu: the website's repository, the only one offered there.
    // Names only; nothing inside is read here.
    website: githubApp()
      ? {
          connected: site !== null,
          repository: siteRepo
            ? { id: siteRepo.id, name: `${siteRepo.owner}/${siteRepo.name}`, defaultBranch: siteRepo.defaultBranch }
            : null,
        }
      : null,
  };
}
