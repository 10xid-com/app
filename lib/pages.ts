/**
 * Every page this service has, and the iD each one answers to.
 *
 * The sign-in pages (`login.*`, and the legacy sign-in, sign-up, code,
 * authenticator, recovery and sso.authorize) are 10xid-com/login's and are
 * listed in its copy of this file. Their iDs are theirs: never reuse them here.
 *
 * Retired here, never to be reused: `account` (the sessions screen). Sessions,
 * the authenticator and recovery codes are managed on the login host
 * (`login.account`). The handoff (`sso.start`, `sso.callback`, `sso.failed`)
 * was briefly removed for WorkOS, which never went live, and is back under its
 * own iDs.
 *
 * The reason this file exists rather than a list typed into a screen: a path is
 * where something lives today, and an iD is what it IS. `/dashboard` may well
 * become `/desk` — it is called a desk in conversation already — and when it
 * does, every link, bookmark and note that said "dashboard" is wrong, while
 * anything that said the iD `dashboard` still points at the right thing. That
 * is the same argument the product makes about people: an email address is
 * where you can be reached and changes, an iD is who you are and does not.
 *
 * So an iD here is STABLE. When a path moves, change `path` and leave `id`
 * alone. When a page is retired, take the row out but never hand its iD to
 * something else — the identities table holds the same rule for people, where
 * `id_code` is unique across every row the table has ever held, revoked ones
 * included.
 *
 * Nothing foreign-keys to these codes, deliberately, for the same reason
 * nothing foreign-keys to `identities.id_code`. An iD is a public handle, not a
 * primary key.
 *
 * `file` is not documentation. It is what test/pages-desk.test.ts compares
 * against the actual contents of app/, so a page added without a row here — or
 * a row left behind after a page is deleted — fails the suite rather than
 * quietly making the desk a lie. A hand-maintained inventory with no such test
 * is wrong within a month.
 */

/** Who can get to it at all. */
export type Audience =
  /** No session needed — these are the ways in. */
  | "public"
  /** Any signed-in person. */
  | "member"
  /** Staff only. A client account is redirected away. */
  | "staff";

export type Kind =
  /** A screen a person reads. */
  | "page"
  /** A URL with no screen: a redirect, a handoff, a machine endpoint. */
  | "machinery";

export interface PageRecord {
  /** The iD. Stable forever — see the note at the top of this file. */
  id: string;
  /** Where it lives today. Change this freely; never change `id` with it. */
  path: string;
  name: string;
  /** One line, in plain words, about what it is for. */
  purpose: string;
  audience: Audience;
  kind: Kind;
  /** Which file implements it. Checked against app/ by the test. */
  file: string;
  /** Machinery only: the methods it actually answers. */
  methods?: string[];
  /** The heading it sits under on the desk. */
  group: Group;
}

export const GROUPS = [
  "Getting in",
  "The work",
  "Your account",
  "Staff",
  "Machinery",
] as const;

export type Group = (typeof GROUPS)[number];

export const PAGES: PageRecord[] = [
  /* -------------------------------------------------------------- */
  /* Getting in                                                      */
  /* -------------------------------------------------------------- */
  {
    id: "front-door",
    path: "/",
    name: "Front door",
    purpose:
      "Sends you to the dashboard, which decides the rest. There is no public landing page.",
    audience: "public",
    kind: "machinery",
    file: "app/page.tsx",
    group: "Getting in",
  },

  {
    id: "access",
    path: "/access",
    name: "Access",
    purpose:
      "Where you land when the portal refuses something, and why: not a member, the business is closed, or your role does not allow it.",
    audience: "member",
    kind: "page",
    file: "app/access/page.tsx",
    group: "Getting in",
  },

  {
    id: "business",
    path: "/business",
    name: "Your businesses",
    purpose:
      "The business switcher: every business you belong to, your role in each, and which one is open. Where you land with several businesses and none chosen.",
    audience: "member",
    kind: "page",
    file: "app/business/page.tsx",
    group: "Getting in",
  },

  /* -------------------------------------------------------------- */
  /* The work                                                        */
  /* -------------------------------------------------------------- */
  {
    id: "dashboard",
    path: "/dashboard",
    name: "Dashboard",
    purpose:
      "The operations overview: what needs attention, the figures, the status breakdown, recent activity.",
    audience: "member",
    kind: "page",
    file: "app/dashboard/page.tsx",
    group: "The work",
  },
  {
    id: "jobs",
    path: "/jobs",
    name: "Jobs",
    purpose: "Every job you can see, which after the visibility work is not the same as every job.",
    audience: "member",
    kind: "page",
    file: "app/jobs/page.tsx",
    group: "The work",
  },
  {
    id: "job",
    path: "/jobs/[id]",
    name: "One job",
    purpose:
      "A single job. The URL carries the UUID, never the ROT-0042 reference — a guessable reference in a URL is a way to walk somebody else's work.",
    audience: "member",
    kind: "page",
    file: "app/jobs/[id]/page.tsx",
    group: "The work",
  },
  {
    id: "team",
    path: "/team",
    name: "Team",
    purpose:
      "Who is in this organization. The page that changes most under the visibility work: it should list who you can SEE, not who is employed.",
    audience: "member",
    kind: "page",
    file: "app/team/page.tsx",
    group: "The work",
  },
  {
    id: "agency",
    path: "/agency",
    name: "Agency",
    purpose:
      "An agency's side of agency access: ask a business for access, name the people who will do the work, take them off, withdraw. Its owner approves the access and each person.",
    audience: "member",
    kind: "page",
    file: "app/agency/page.tsx",
    group: "The work",
  },
  {
    id: "pages",
    path: "/pages",
    name: "Pages",
    purpose: "This desk. Every page in the service and the iD each one answers to.",
    audience: "member",
    kind: "page",
    file: "app/pages/page.tsx",
    group: "The work",
  },

  /* -------------------------------------------------------------- */
  /* Staff                                                           */
  /* -------------------------------------------------------------- */
  {
    id: "clients",
    path: "/staff",
    name: "Clients",
    purpose:
      "The client picker. Choosing one writes a 30-minute grant with the reason you typed, and raises the acting-on banner.",
    audience: "staff",
    kind: "page",
    file: "app/staff/page.tsx",
    group: "Staff",
  },
  {
    id: "act-as",
    path: "/act-as",
    name: "Act as",
    purpose:
      "Be somebody else for an hour, to see Flow from their side. Reason required, named across every screen, and never able to change their address, enrol an authenticator or read their recovery codes.",
    // Not "staff", and the difference is load-bearing. While acting as a
    // client the session's effective role IS client, and this page is the way
    // back — hiding it from the audience it is currently wearing would leave
    // the exit reachable only from a banner. The page itself refuses anybody
    // whose REAL session is not staff.
    audience: "member",
    kind: "page",
    file: "app/act-as/page.tsx",
    group: "Staff",
  },
  {
    id: "chat",
    path: "/chat",
    name: "Chat Boss",
    purpose:
      "Conversations in Ask or Plan mode, grounded in the open business's records, with a receipt for what every answer saw. Only for the people on the Chat Boss list, and only on a business they belong to.",
    audience: "member",
    kind: "page",
    file: "app/chat/page.tsx",
    group: "The work",
  },
  {
    id: "keys",
    path: "/staff/keys",
    name: "Keys",
    purpose: "API keys. They file work in and can read nothing back out.",
    audience: "staff",
    kind: "page",
    file: "app/staff/keys/page.tsx",
    group: "Staff",
  },

  /* -------------------------------------------------------------- */
  /* Machinery                                                       */
  /* -------------------------------------------------------------- */
  {
    id: "healthz",
    path: "/healthz",
    name: "Healthcheck",
    purpose:
      "For Railway: 200 once the server has started, which it refuses to do with the wrong session settings or a privileged database role.",
    audience: "public",
    kind: "machinery",
    file: "app/healthz/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "api.jobs",
    path: "/api/v1/jobs",
    name: "File a job",
    purpose:
      "POST only, for machines holding an API key. A GET is answered with an explicit 405: there is no read access behind a key, by design.",
    audience: "public",
    kind: "machinery",
    file: "app/api/v1/jobs/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.workspace.messages",
    path: "/api/workspace/conversations/[id]/messages",
    name: "Workspace answers",
    purpose:
      "Sends a message in a workspace conversation and streams the answer, its tool activity and its receipts back. Staff only; the conversation must belong to this client and this person.",
    audience: "staff",
    kind: "machinery",
    file: "app/api/workspace/conversations/[id]/messages/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.workspace.repository",
    path: "/api/workspace/conversations/[id]/repository",
    name: "Workspace file browser",
    purpose:
      "Read-only views of a conversation's repository at its branch: branches, one folder at a time, file-name and text search, and files changed from the default branch. Staff only; the repository comes from the conversation, never the request.",
    audience: "staff",
    kind: "machinery",
    file: "app/api/workspace/conversations/[id]/repository/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "api.workspace.repositories",
    path: "/api/workspace/repositories",
    name: "Repositories to link",
    purpose:
      "The repositories the GitHub App is installed on, by name only, for staff linking one to the client in scope.",
    audience: "staff",
    kind: "machinery",
    file: "app/api/workspace/repositories/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "sso.start",
    path: "/auth/sso/start",
    name: "Handoff — start",
    purpose:
      "The portal asks the login host to sign this visitor in. Step one of three; the return path stays here.",
    audience: "public",
    kind: "machinery",
    file: "app/auth/sso/start/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "sso.callback",
    path: "/auth/sso/callback",
    name: "Handoff — callback",
    purpose:
      "The portal spends the ticket, once, and issues its own host-only session, ending when the sign-in does.",
    audience: "public",
    kind: "machinery",
    file: "app/auth/sso/callback/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "sso.failed",
    path: "/auth/sso/failed",
    name: "Handoff failed",
    purpose: "One message for every way the handoff can fail, so a failure reveals nothing.",
    audience: "public",
    kind: "page",
    file: "app/auth/sso/failed/page.tsx",
    group: "Machinery",
  },
];

/**
 * What one person should be shown.
 *
 * Staff see everything. A client account sees the pages it can actually reach,
 * because listing `/staff/keys` to somebody who is redirected away from it is
 * not an inventory, it is a locked door with a label on it.
 */
export function pagesFor(isStaff: boolean): PageRecord[] {
  return isStaff ? PAGES : PAGES.filter((p) => p.audience !== "staff");
}

/** How many rows a client account is not being shown. */
export function hiddenFrom(isStaff: boolean): number {
  return isStaff ? 0 : PAGES.length - pagesFor(false).length;
}

/** Look one up by its iD. */
export function pageById(id: string): PageRecord | undefined {
  return PAGES.find((p) => p.id === id);
}
