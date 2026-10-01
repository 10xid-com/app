/**
 * Every page this service has, and the iD each one answers to.
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
      "Decides where you belong and sends you there. Staff to the chat, everybody else to the desk, signed out to sign-in. There is no public landing page.",
    audience: "public",
    kind: "machinery",
    file: "app/page.tsx",
    group: "Getting in",
  },
  {
    id: "sign-in",
    path: "/auth/login",
    name: "Sign in",
    purpose: "Give your email address and we post you a six-digit code. No password exists to type.",
    audience: "public",
    kind: "page",
    file: "app/auth/login/page.tsx",
    group: "Getting in",
  },
  {
    id: "sign-up",
    path: "/auth/signup",
    name: "Accept an invitation",
    purpose: "Where an invited person turns their invitation into an account.",
    audience: "public",
    kind: "page",
    file: "app/auth/signup/page.tsx",
    group: "Getting in",
  },
  {
    id: "code",
    path: "/auth/verify",
    name: "Six-digit code",
    purpose: "Type the code from the email. Proves you hold the inbox.",
    audience: "public",
    kind: "page",
    file: "app/auth/verify/page.tsx",
    group: "Getting in",
  },
  {
    id: "authenticator",
    path: "/auth/2fa",
    name: "Authenticator",
    purpose:
      "The second factor. Staff reach every client's data, and an inbox is the thing most likely to be taken, so holding it is not enough on its own.",
    audience: "public",
    kind: "page",
    file: "app/auth/2fa/page.tsx",
    group: "Getting in",
  },
  {
    id: "recovery",
    path: "/auth/recovery-codes",
    name: "Recovery codes",
    purpose:
      "The one-time list shown when you enrol an authenticator. It is the answer to losing the phone, and it is shown once.",
    audience: "public",
    kind: "page",
    file: "app/auth/recovery-codes/page.tsx",
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
  /* Your account                                                    */
  /* -------------------------------------------------------------- */
  {
    id: "account",
    path: "/account/sessions",
    name: "Your details and devices",
    purpose: "Where you are signed in, and how to sign a device out. Reached from the Pin.",
    audience: "member",
    kind: "page",
    file: "app/account/sessions/page.tsx",
    group: "Your account",
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
    name: "Chat",
    purpose:
      "An AI chat box on free models through OpenRouter, and where staff land after signing in. Nothing typed into it is saved.",
    audience: "staff",
    kind: "page",
    file: "app/chat/page.tsx",
    group: "Staff",
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
    id: "sso.start",
    path: "/auth/sso/start",
    name: "Handoff — start",
    purpose:
      "A client domain asks the login host whether this visitor is already signed in. Step one of three.",
    audience: "public",
    kind: "machinery",
    file: "app/auth/sso/start/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "sso.authorize",
    path: "/auth/sso/authorize",
    name: "Handoff — authorize",
    purpose:
      "The login host mints a single-use ticket, hashed at rest and bound to the one host that asked for it.",
    audience: "public",
    kind: "machinery",
    file: "app/auth/sso/authorize/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "sso.callback",
    path: "/auth/sso/callback",
    name: "Handoff — callback",
    purpose: "The client domain spends the ticket. Spending it destroys it.",
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
    purpose:
      "The only part of the handoff a person is ever meant to look at, and only when something went wrong.",
    audience: "public",
    kind: "page",
    file: "app/auth/sso/failed/page.tsx",
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
    id: "api.chat",
    path: "/api/chat",
    name: "Chat answers",
    purpose:
      "What the chat box calls. Takes the conversation, streams the answer back as text, and refuses any session that is not staff.",
    audience: "staff",
    kind: "machinery",
    file: "app/api/chat/route.ts",
    methods: ["POST"],
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
