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
  "Coming soon",
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
    id: "grant",
    path: "/grants/[id]",
    name: "Agency grant",
    purpose:
      "The link in an expiry reminder. Opens the grant on the business's Team page or the agency's Agency page, for their owners and managers, offering to open the right business first. Anybody else gets a 404.",
    audience: "member",
    kind: "page",
    file: "app/grants/[id]/page.tsx",
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

  {
    id: "channel.id",
    path: "/channels/id",
    name: "iD",
    purpose:
      "The business's own iD: live in the card, Launch to open it at its own address, and the themes it can wear. A business with no iD yet (ID_PREVIEWS) sees a drawing; editing and themes are placeholders until the iD builder ships.",
    audience: "member",
    kind: "page",
    file: "app/channels/id/page.tsx",
    group: "The work",
  },

  {
    id: "website",
    path: "/channels/website",
    name: "Website",
    purpose:
      "The business's website, run from the portal: an owner connects it; editors and publishers see what is on it; publishers publish. Read live from the site over signed requests.",
    audience: "member",
    kind: "page",
    file: "app/channels/website/page.tsx",
    group: "The work",
  },
  {
    id: "instagram",
    path: "/channels/instagram",
    name: "Instagram",
    purpose:
      "The business's Instagram account: an owner or manager connects it through Instagram's own sign-in; publishers post photos, Reels and carousels; everyone sees recent posts with likes, comments and reach.",
    audience: "member",
    kind: "page",
    file: "app/channels/instagram/page.tsx",
    group: "The work",
  },
  {
    id: "facebook",
    path: "/channels/facebook",
    name: "Facebook",
    purpose:
      "The business's Facebook Page: an owner or manager connects it through Facebook Login and chooses the Page; publishers post text, photos or a video; everyone sees recent posts with reactions, comments and shares.",
    audience: "member",
    kind: "page",
    file: "app/channels/facebook/page.tsx",
    group: "The work",
  },
  {
    id: "website.posts",
    path: "/channels/website/posts",
    name: "Blog",
    purpose: "The connected website's blog posts, searchable and filtered by status, read live from the site. Editors and up.",
    audience: "member",
    kind: "page",
    file: "app/channels/website/posts/page.tsx",
    group: "The work",
  },
  {
    id: "website.post",
    path: "/channels/website/posts/[id]",
    name: "One post",
    purpose:
      "Write or edit one blog post, saved through the site's own save route. Editors draft; a live post, and making one live, is a publisher's.",
    audience: "member",
    kind: "page",
    file: "app/channels/website/posts/[id]/page.tsx",
    group: "The work",
  },

  /* -------------------------------------------------------------- */
  /* Coming soon: in the navigation, not built yet                   */
  /* -------------------------------------------------------------- */
  {
    id: "orders",
    path: "/orders",
    name: "Orders",
    purpose:
      "Placeholder until it is built. Every order from every channel, in one list.",
    audience: "member",
    kind: "page",
    file: "app/orders/page.tsx",
    group: "Coming soon",
  },
  {
    id: "products",
    path: "/products",
    name: "Products",
    purpose:
      "Placeholder until it is built. The catalogue every channel draws from: products, variants, prices and stock.",
    audience: "member",
    kind: "page",
    file: "app/products/page.tsx",
    group: "Coming soon",
  },
  {
    id: "customers",
    path: "/customers",
    name: "Customers",
    purpose:
      "Placeholder until it is built. The people who buy from the business, and what they have bought.",
    audience: "member",
    kind: "page",
    file: "app/customers/page.tsx",
    group: "Coming soon",
  },
  {
    id: "growth",
    path: "/growth",
    name: "Growth",
    purpose:
      "Placeholder until it is built. Campaigns and the work that brings new customers in.",
    audience: "member",
    kind: "page",
    file: "app/growth/page.tsx",
    group: "Coming soon",
  },
  {
    id: "discounts",
    path: "/discounts",
    name: "Discounts",
    purpose:
      "Placeholder until it is built. Discount codes and automatic offers.",
    audience: "member",
    kind: "page",
    file: "app/discounts/page.tsx",
    group: "Coming soon",
  },
  {
    id: "content",
    path: "/content",
    name: "Content",
    purpose:
      "Placeholder until it is built. Pages, posts, files and media, in one library.",
    audience: "member",
    kind: "page",
    file: "app/content/page.tsx",
    group: "Coming soon",
  },
  {
    id: "markets",
    path: "/markets",
    name: "Markets",
    purpose:
      "Placeholder until it is built. Where the business sells, and the currencies and languages each place gets.",
    audience: "member",
    kind: "page",
    file: "app/markets/page.tsx",
    group: "Coming soon",
  },
  {
    id: "finance",
    path: "/finance",
    name: "Finance",
    purpose:
      "Placeholder until it is built. Payouts, invoices, billing and tax settings.",
    audience: "member",
    kind: "page",
    file: "app/finance/page.tsx",
    group: "Coming soon",
  },
  {
    id: "analytics",
    path: "/analytics",
    name: "Analytics",
    purpose:
      "Placeholder until it is built. Sales, traffic and reports for the business.",
    audience: "member",
    kind: "page",
    file: "app/analytics/page.tsx",
    group: "Coming soon",
  },
  {
    id: "settings",
    path: "/settings",
    name: "Settings",
    purpose:
      "Placeholder until it is built. The business's details, domains and notifications, with links to the settings that already live elsewhere.",
    audience: "member",
    kind: "page",
    file: "app/settings/page.tsx",
    group: "Coming soon",
  },
  {
    id: "channels",
    path: "/channels",
    name: "Channels",
    purpose:
      "Add channel: every channel the business can show up on, connected or not, each leading to its own page to connect it. The sidebar lists only the connected ones.",
    audience: "member",
    kind: "page",
    file: "app/channels/page.tsx",
    group: "The work",
  },
  {
    id: "channel",
    path: "/channels/[channel]",
    name: "One channel",
    purpose:
      "Placeholder for a channel that cannot be connected yet: LinkedIn. Any other name is a 404; the website, Instagram and Facebook have their own pages.",
    audience: "member",
    kind: "page",
    file: "app/channels/[channel]/page.tsx",
    group: "Coming soon",
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
    id: "api.agency-reminders",
    path: "/api/v1/cron/agency-reminders",
    name: "Agency expiry reminders",
    purpose:
      "POST only, for the daily scheduler, with the CRON_SECRET as a bearer token; a 404 until that secret is set. Tells each owner of a business and of its agency, once, that agency access ends within seven days. With ?test=<address>@resend.dev it sends one sample of each email to that test inbox instead.",
    audience: "public",
    kind: "machinery",
    file: "app/api/v1/cron/agency-reminders/route.ts",
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
    id: "api.website.images",
    path: "/api/website/images",
    name: "Blog image upload",
    purpose:
      "An image from the blog editor, passed to the business's own website to store; answers with where the site keeps it.",
    audience: "member",
    kind: "machinery",
    file: "app/api/website/images/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.instagram.connect",
    path: "/api/instagram/connect",
    name: "Connect Instagram",
    purpose: "Sends an owner or manager to Instagram's sign-in, with a state value kept in their browser for the business that is open.",
    audience: "member",
    kind: "machinery",
    file: "app/api/instagram/connect/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "api.instagram.callback",
    path: "/api/instagram/callback",
    name: "Instagram sign-in return",
    purpose:
      "Where Instagram's sign-in comes back: checks the state, turns the code into a 60-day token, reads the account, and stores the connection with the token sealed.",
    audience: "member",
    kind: "machinery",
    file: "app/api/instagram/callback/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "api.social.photos",
    path: "/api/social/photos",
    name: "Social photo upload",
    purpose: "A JPEG from the composer (Instagram, Facebook), put in the media store for up to 24 hours until it is posted; answers with its id.",
    audience: "member",
    kind: "machinery",
    file: "app/api/social/photos/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.social.videos",
    path: "/api/social/videos",
    name: "Start a video upload",
    purpose: "Starts a video upload for a post (Instagram, Facebook): MP4 or MOV, up to 300MB, 3 seconds to 15 minutes; the video then comes up in 8MB parts.",
    audience: "member",
    kind: "machinery",
    file: "app/api/social/videos/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.social.video-part",
    path: "/api/social/videos/[id]/parts/[part]",
    name: "Video upload part",
    purpose: "One 8MB part of a video upload, to an upload this business started and has not finished.",
    audience: "member",
    kind: "machinery",
    file: "app/api/social/videos/[id]/parts/[part]/route.ts",
    methods: ["PUT"],
    group: "Machinery",
  },
  {
    id: "api.social.video-complete",
    path: "/api/social/videos/[id]/complete",
    name: "Finish a video upload",
    purpose: "Puts a video's parts together and checks the whole is the size it was started with; then it can be posted.",
    audience: "member",
    kind: "machinery",
    file: "app/api/social/videos/[id]/complete/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.instagram.posts",
    path: "/api/instagram/posts",
    name: "Post to Instagram",
    purpose:
      "Posts one photo, one video (as a Reel) or a carousel of photos and videos, with a caption, to the business's connected account; Instagram fetches each file from a presigned address, and the files are deleted once posted.",
    audience: "member",
    kind: "machinery",
    file: "app/api/instagram/posts/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.facebook.connect",
    path: "/api/facebook/connect",
    name: "Connect Facebook",
    purpose: "Sends an owner or manager to Facebook Login, with a state value kept in their browser for the business that is open.",
    audience: "member",
    kind: "machinery",
    file: "app/api/facebook/connect/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "api.facebook.callback",
    path: "/api/facebook/callback",
    name: "Facebook sign-in return",
    purpose:
      "Where Facebook Login comes back: checks the state and the Page permissions, reads the Pages the person manages, and connects the one Page or asks which; only the Page's own token is stored, sealed.",
    audience: "member",
    kind: "machinery",
    file: "app/api/facebook/callback/route.ts",
    methods: ["GET"],
    group: "Machinery",
  },
  {
    id: "api.facebook.posts",
    path: "/api/facebook/posts",
    name: "Post to Facebook",
    purpose: "Posts text, text with up to ten photos, or text with a video to the business's connected Page, from presigned addresses.",
    audience: "member",
    kind: "machinery",
    file: "app/api/facebook/posts/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.facebook.deauthorize",
    path: "/api/v1/facebook/deauthorize",
    name: "Facebook deauthorize notice",
    purpose: "Meta's notice that someone removed the app from Facebook: checked against the app secret, then their Page connection is ended and its token erased.",
    audience: "public",
    kind: "machinery",
    file: "app/api/v1/facebook/deauthorize/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.facebook.data-deletion",
    path: "/api/v1/facebook/data-deletion",
    name: "Facebook data deletion request",
    purpose: "Meta's data deletion callback for Facebook: signed, ends the connection and erases its token, and answers with a status address and code.",
    audience: "public",
    kind: "machinery",
    file: "app/api/v1/facebook/data-deletion/route.ts",
    methods: ["GET", "POST"],
    group: "Machinery",
  },
  {
    id: "api.instagram.deauthorize",
    path: "/api/v1/instagram/deauthorize",
    name: "Instagram deauthorize notice",
    purpose: "Meta's notice that someone removed the app: checked against the app secret, then their connection is ended and its token erased.",
    audience: "public",
    kind: "machinery",
    file: "app/api/v1/instagram/deauthorize/route.ts",
    methods: ["POST"],
    group: "Machinery",
  },
  {
    id: "api.instagram.data-deletion",
    path: "/api/v1/instagram/data-deletion",
    name: "Instagram data deletion request",
    purpose: "Meta's data deletion callback: signed, ends the connection and erases its token, and answers with a status address and code.",
    audience: "public",
    kind: "machinery",
    file: "app/api/v1/instagram/data-deletion/route.ts",
    methods: ["GET", "POST"],
    group: "Machinery",
  },
  {
    id: "api.website.post-preview",
    path: "/api/website/posts/[id]/preview",
    name: "Blog post preview",
    purpose:
      "A saved post drawn by the business's own website as its next build will draw it, draft or not; served sandboxed to the editor's Preview on site.",
    audience: "member",
    kind: "machinery",
    file: "app/api/website/posts/[id]/preview/route.ts",
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
