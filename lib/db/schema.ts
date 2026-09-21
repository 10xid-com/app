import {
  bigserial,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Secrets are stored as the SHA-256 of the value we handed out, never the value
 * itself. Reading this database therefore yields no usable session cookie, no
 * sign-in code and no handoff ticket.
 */
const sha256 = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const organizationType = pgEnum("organization_type", [
  "client",
  "internal",
]);
export const membershipRole = pgEnum("membership_role", [
  "owner",
  "member",
  "staff",
]);
/**
 * Can people inside one organization see each other at all?
 *
 * `closed` is the default and the interesting case. An agency does not want
 * its client meeting the contractor doing the work, and a company of two
 * hundred does not want a new starter able to enumerate everybody. So being
 * in the same organization grants NOTHING on its own — visibility comes from
 * an explicit connection, and the admin decides whether membership creates
 * one automatically.
 */
export const memberVisibility = pgEnum("member_visibility", ["open", "closed"]);

/** Why two people can see each other. Kept because "how" changes what may be revoked. */
export const connectionSource = pgEnum("connection_source", [
  /** The organization is `open`, so membership alone did it. */
  "org_open",
  /** One invited the other, or an admin put them together. */
  "invitation",
  /** They scanned each other's iD — the two people were in a room. */
  "id_scan",
  /** They ended up on the same piece of work. */
  "shared_work",
  /** Someone with the authority simply said so. */
  "manual",
]);

/** What a granted capability applies TO. */
export const permissionScope = pgEnum("permission_scope", [
  "organization",
  "department",
  "task_type",
  "task",
  "user",
]);

export const jobDirection = pgEnum("job_direction", [
  "from_client",
  "to_client",
]);
export const jobStatus = pgEnum("job_status", [
  "draft",
  "open",
  "in_progress",
  "awaiting_approval",
  "changes_requested",
  "approved",
  "completed",
  "cancelled",
]);

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: organizationType("type").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Per-client theme tokens, applied by hostname. Never authorisation. */
  brandPrimaryHex: text("brand_primary_hex"),
  brandLogoUrl: text("brand_logo_url"),
  /**
   * Per-client counter behind the human job reference (ROT-0042). Incremented
   * atomically in the same statement that reads it, so two people raising a job
   * at the same moment cannot be handed the same number.
   */
  jobCounter: integer("job_counter").notNull().default(0),
  /**
   * Whether belonging to this organization lets you see the other people in
   * it. Defaults to `closed` — the safe answer, and the one an agency needs.
   */
  memberVisibility: memberVisibility("member_visibility")
    .notNull()
    .default("closed"),
  /**
   * The person answerable for this organization. Set when a brand is created,
   * and the reason a brand can be handed over: selling one is transferring
   * this, not migrating anybody's account.
   */
  ownerUserId: uuid("owner_user_id"),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * Which hostname belongs to which company. This drives BRANDING and ROUTING
 * only. What a person may read comes from their session and membership — the
 * host a request arrived on carries no authority whatsoever.
 *
 * It is also the allowlist the cross-domain handoff redeems against: a return
 * destination is the id of a row in this table, never a URL, which makes an
 * open redirect structurally impossible rather than carefully guarded.
 */
export const organizationDomains = pgTable(
  "organization_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Stored lowercase, including port in development. */
    hostname: text("hostname").notNull().unique(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("organization_domains_org_idx").on(t.organizationId)],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stored lowercase. The identity — there is no password column. */
  email: text("email").notNull().unique(),
  fullName: text("full_name"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  /** Derived from membership of the internal organization; stored for speed. */
  isStaff: boolean("is_staff").notNull().default(false),
  /**
   * A service account: the identity an API key acts as, so automated work is
   * attributable to a named thing rather than to a person's login.
   *
   * It is a real row in this table on purpose — a job raised by Northstar's
   * website has the same shape as one raised by a person, so nothing downstream
   * needs a second code path. What it must never do is sign in: the sign-in
   * route refuses these accounts outright, so possession of the mailbox (there
   * is none — the address is on a .invalid domain) would still achieve nothing.
   */
  isService: boolean("is_service").notNull().default(false),
  /**
   * TOTP shared secret, encrypted at rest with AES-256-GCM. A database dump
   * therefore yields no working second factor — which is the whole point of
   * having one, since the first factor already lives in an inbox.
   */
  totpSecret: text("totp_secret"),
  totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * An address is a CLAIM attached to an account, never the account itself.
 *
 * The obvious design puts one `email` column on the person, and it is wrong in
 * two ways that only surface once there are real users. People change
 * addresses — and if the address IS the identity, changing it either forks the
 * account or quietly rewrites who did what. Worse, shared mailboxes are normal
 * in this trade: `orders@club.org` is one address and frequently several
 * humans, and `jane@club.org` arriving two years later is the same person who
 * used to be `orders@`.
 *
 * So addresses live here — many per account, each verified on its own — and
 * signing in resolves THROUGH this table. One address is marked primary,
 * because outbound mail needs a single answer, and a partial unique index
 * enforces exactly one per account rather than trusting every writer to.
 *
 * `email` is unique across the whole table, which is what stops two accounts
 * claiming the same address and gives "who is this?" one answer at sign-in.
 */
export const userEmails = pgTable(
  "user_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** Stored lowercase. Unique across every account, not merely per account. */
    email: text("email").notNull().unique(),
    /**
     * Where mail goes. Exactly one per account, enforced by a partial unique
     * index in the migration — Drizzle cannot express `WHERE is_primary`, and a
     * plain unique index here would permit only one NON-primary address too.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    /**
     * Verified independently of every other address. An unverified address can
     * be claimed but cannot be signed in with, so adding somebody else's
     * address to your account achieves nothing.
     */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("user_emails_user_idx").on(t.userId)],
);

/**
 * The iD — and the reason it is a table rather than a column on `users`.
 *
 * Everybody who signs in anywhere gets an ACCOUNT. Far fewer will hold an iD:
 * it is issued deliberately, it can be given up, and it may one day be
 * transferred. Those are all things that happen TO an identifier, and none of
 * them should be able to reach the account's history.
 *
 * Hence the rule this table exists to make enforceable: NOTHING references
 * `id_code`. Jobs, memberships, audit rows and sessions all point at
 * `users.id`, a uuid that never changes for the life of the account.
 * Transferring an iD therefore moves one row and rewrites nothing. Were a job
 * ever to record "assigned to 10X-4K7P2" instead of the account uuid, a
 * transfer would silently reassign that job's history to whoever holds the code
 * next — and the evidence of the previous holder is exactly what would be
 * overwritten, so it could not be detected afterwards, let alone undone.
 *
 * Two constraints carry the model, both in the database, because neither
 * survives being a convention:
 *
 *   * at most ONE live iD per account — a partial unique index on user_id
 *     where revoked_at is null, so revoked ones do not block a reissue;
 *   * an id_code is unique FOREVER, revoked rows included, so a code that was
 *     once somebody's can never be handed to somebody else.
 */
export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * The public identifier. Unique across every row this table has ever held,
     * including revoked ones — see above.
     *
     * Deliberately NOT a foreign key target anywhere in this schema.
     */
    idCode: text("id_code").notNull().unique(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set rather than deleted, so "was issued and given up" stays a fact. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [index("identities_user_idx").on(t.userId)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    role: membershipRole("role").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("memberships_user_org_idx").on(t.userId, t.organizationId),
    index("memberships_org_idx").on(t.organizationId),
  ],
);

/**
 * A subdivision of an organization — marketing, graphic design, the shop floor.
 *
 * Departments exist because "who may see this" is usually answered by team
 * rather than by person. Granting a capability to a department and moving
 * people in and out of it is the difference between administering a company
 * of twenty and administering one of two hundred.
 */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt,
    updatedAt,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("departments_org_slug_idx").on(t.organizationId, t.slug),
    index("departments_org_idx").on(t.organizationId),
  ],
);

export const departmentMembers = pgTable(
  "department_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    createdAt,
  },
  (t) => [
    uniqueIndex("department_members_dept_user_idx").on(t.departmentId, t.userId),
    index("department_members_user_idx").on(t.userId),
  ],
);

/**
 * Who can see whom.
 *
 * The rule this table exists to enforce: **people are invisible to each other
 * until something makes them visible.** Sharing an employer is not that
 * something, and neither is sharing a job — both are decisions an admin makes,
 * not facts the database should assume.
 *
 * The worked example this was designed against. Tom is one of eighteen
 * designers. John, a marketing head, sends a booth to Jane, who micromanages:
 * everything routes through her, so John and Tom never need to see each other.
 * John sends a banner to Sam, who works the other way: she picks Tom and steps
 * back, so John and Tom DO need to see each other, and only for that job. Same
 * company, same two people, opposite answers — which is why this cannot be
 * derived from membership and has to be recorded.
 *
 * A pair is stored ONCE, with the lower uuid in `a_user_id`. Seeing is mutual:
 * there is no direction in which Tom can see John but John cannot see Tom, and
 * a two-row design would eventually hold exactly that contradiction.
 *
 * Revoked rather than deleted, because "we were connected and no longer are"
 * is a different fact from "we never were", and the first one explains why
 * somebody can still see a task they were part of.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The organization this connection lives inside, or NULL when two people
     * simply know each other — the QR-scan case. A personal connection is not
     * an organization's to revoke, and outlives anybody's employment.
     */
    organizationId: uuid("organization_id").references(() => organizations.id),
    /** Always the numerically lower uuid of the pair. Enforced by a check. */
    aUserId: uuid("a_user_id")
      .notNull()
      .references(() => users.id),
    bUserId: uuid("b_user_id")
      .notNull()
      .references(() => users.id),
    source: connectionSource("source").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("connections_a_idx").on(t.aUserId),
    index("connections_b_idx").on(t.bUserId),
    index("connections_org_idx").on(t.organizationId),
  ],
);

/**
 * What somebody may do, stored as data rather than written as code.
 *
 * `capability` is deliberately free text — "task.create", "person.see",
 * "task.approve", whatever tomorrow needs. Adding a capability is inserting a
 * row, not shipping a migration and a deploy. That is the whole point: roles
 * that cannot be invented after the fact are roles that stop fitting the
 * business within a year, and this business intends to keep refining them
 * indefinitely.
 *
 * `scopeType` and `scopeId` say what it applies to: the whole organization, a
 * department, a kind of work, one specific task, or one specific person. So
 * "Sam may assign graphic design work" and "Tom may see John, but only on the
 * banner" are the same shape of row.
 *
 * The three coarse roles on `memberships` stay. They are the sensible default
 * a new member arrives with; this table is how that default gets narrowed or
 * widened afterwards without inventing a new role each time.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    capability: text("capability").notNull(),
    scopeType: permissionScope("scope_type").notNull(),
    /** Null when the scope is the organization itself. */
    scopeId: uuid("scope_id"),
    /**
     * Grants are positive by default. A DENY wins over any grant, so one row
     * can carve a person out of something their department was given — which
     * is otherwise only expressible by taking the grant off the department and
     * re-granting it to everybody else one at a time.
     */
    deny: boolean("deny").notNull().default(false),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("permissions_user_idx").on(t.userId, t.organizationId),
    index("permissions_org_capability_idx").on(t.organizationId, t.capability),
  ],
);

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * Two clocks, both enforced here rather than in the cookie:
 *   idleSeconds       — restarts on every visit. Null means no idle timeout.
 *   absoluteExpiresAt — renewal can never push past it.
 *
 * Both are COPIED ONTO THE ROW at creation, so promoting someone to staff
 * tomorrow does not retroactively stretch a session that is already live.
 *
 * Liveness is decided from this row, never from the cookie's own expiry — a
 * browser can keep sending an expired cookie indefinitely.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: sha256("token_hash").notNull().unique(),
    /** The one host this cookie lives on. Each domain gets its own session. */
    issuedForHost: text("issued_for_host").notNull(),
    createdAt,
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    idleSeconds: integer("idle_seconds"),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
    }).notNull(),
    roleAtCreation: text("role_at_creation").notNull(),
    /**
     * When this session passed its second factor. Null on a staff session means
     * the email code has been accepted and nothing else — it can reach the
     * enrolment screen and nothing else.
     */
    secondFactorAt: timestamp("second_factor_at", { withTimezone: true }),
    /** Staff only: the client they are currently acting on. */
    activeOrganizationId: uuid("active_organization_id").references(
      () => organizations.id,
    ),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const signInCodes = pgTable(
  "sign_in_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: sha256("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestedIp: text("requested_ip"),
    createdAt,
  },
  (t) => [index("sign_in_codes_email_idx").on(t.email)],
);

/**
 * How somebody comes to have an account at all.
 *
 * There is no open registration, and this is the reason the sign-up screen can
 * exist without one: a portal is a set of separate companies' data, and an
 * address typed into a form carries nothing that says which company it belongs
 * to. Guessing would be the whole tenancy model decided by a stranger.
 *
 * So an account starts here instead. Somebody who already has access names an
 * address and a company, and the invitation is what the sign-up screen checks
 * against. Until it is accepted there is no user row — an invitation on its own
 * grants nothing and can be withdrawn.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lowercase, matched exactly. */
    email: text("email").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    role: membershipRole("role").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("invitations_email_idx").on(t.email),
    index("invitations_org_idx").on(t.organizationId),
  ],
);

/**
 * The way back in when the authenticator is gone.
 *
 * Once an account holds a confirmed authenticator, the emailed code stops
 * working for it — otherwise anyone holding the inbox could simply ignore the
 * authenticator, and it would be decorative. That is the right trade, but it
 * means a lost or wiped phone is a permanent lockout unless something else
 * exists. These are that something else.
 *
 * Ten codes, issued at enrolment, shown once and stored only as hashes. Each
 * works exactly once, consumed by an atomic update, so a list photographed over
 * a shoulder is worth less with every code that gets used.
 */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    codeHash: sha256("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/**
 * The cross-domain handoff, shaped as an OAuth authorization code.
 *
 * Opaque 32 random bytes, stored hashed, valid for seconds, redeemable exactly
 * once by an atomic update, bound to ONE destination host, and tied to the
 * session that minted it so signing out kills tickets still in flight.
 */
export const ssoTickets = pgTable(
  "sso_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketHash: sha256("ticket_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** The only host permitted to redeem this ticket. */
    audienceHost: text("audience_host").notNull(),
    /** A path within that host. Never a full URL, never cross-host. */
    returnPath: text("return_path").notNull().default("/"),
    sourceSessionId: uuid("source_session_id")
      .notNull()
      .references(() => sessions.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("sso_tickets_session_idx").on(t.sourceSessionId)],
);

/**
 * Staff do not get ambient power over every client. They exchange their
 * identity for a time-boxed grant to ONE client, carrying a reason typed at the
 * moment of switching — so the audit line says which client was opened and why,
 * not merely that an admin was active.
 */
export const staffGrants = pgTable(
  "staff_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    reason: text("reason").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
  },
  (t) => [index("staff_grants_session_idx").on(t.sessionId)],
);

/**
 * Acting as somebody else.
 *
 * The same shape as `staff_grants` above, and deliberately so: staff already
 * trade their identity for a time-boxed, reasoned, logged grant to one CLIENT,
 * and this is the same trade for one PERSON. Modelling it any other way would
 * have produced a second kind of elevated access with its own rules, which is
 * how one of them ends up with weaker ones.
 *
 * What it is FOR: Flow looks different from each side, and the only way to see
 * a client's side is to be them. Signing in as them is impossible by design —
 * the code goes to their real inbox — and asking them for it would be asking
 * for their credential.
 *
 * What separates it from a back door is written into the columns:
 *
 *   * `session_id` — a grant belongs to ONE browser session. It cannot be
 *     picked up by another login, and ending that session ends it.
 *   * `actor_user_id` — the real person. Never overwritten by the target, and
 *     the identity every check is made against.
 *   * `target_user_id` — who they appear as.
 *   * `reason` — typed at the moment of starting, minimum eight characters,
 *     the same floor `staff_grants` uses. This table IS the audit, so a row
 *     without a reason would be a row that cannot answer why.
 *   * `expires_at` — sixty minutes, renewed by starting another one rather
 *     than by extending this row, so each stretch keeps its own reason.
 *   * `ended_at` — set when it is given up. Distinct from `expires_at` on
 *     purpose: "given up at 14:12" and "lapsed at 15:00" are different facts,
 *     and `staff_grants` cannot tell them apart because it stamps expires_at
 *     to end early. A live grant is one with no ended_at whose expires_at is
 *     still in the future.
 *
 * Nothing is deleted. The application role holds no DELETE on this table.
 */
export const actAsGrants = pgTable(
  "act_as_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The one browser session this grant is attached to. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    /** The real person. Every permission check is made against this account. */
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    /** Who they are appearing as. */
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when given up. Null while it is still running or has merely lapsed. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("act_as_grants_session_idx").on(t.sessionId),
    index("act_as_grants_actor_idx").on(t.actorUserId),
    index("act_as_grants_target_idx").on(t.targetUserId),
  ],
);

/**
 * Keys for machines.
 *
 * A client's own website has work to hand over — Northstar's estimate requests —
 * and there is no person behind that request to sign in. The alternative people
 * reach for is to let the automation use someone's personal login, which means
 * one leaked credential is both a human's whole account and every script that
 * ever borrowed it. So a key is its own credential:
 *
 *   * bound to ONE company, which is where its jobs land, and to a service
 *     account, which is who they are attributed to;
 *   * stored as a hash, so this table leaks nothing if it is read;
 *   * write-only in what it can do — there is no read endpoint behind it, so a
 *     stolen key can file work, not extract it;
 *   * revocable on its own, without touching anybody's login.
 *
 * `prefix` is the first few characters of the key, kept in clear. It is not a
 * secret and cannot be used to authenticate; it exists so a key can be told
 * apart from its siblings in a list, and so a leaked key found in a log can be
 * matched to a row and revoked.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** The service account jobs filed with this key are attributed to. */
    serviceUserId: uuid("service_user_id")
      .notNull()
      .references(() => users.id),
    /** What this key is for, in words: "Northstar website — estimate form". */
    label: text("label").notNull(),
    keyHash: sha256("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt,
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_org_idx").on(t.organizationId)],
);

/* ------------------------------------------------------------------ */
/* The work                                                            */
/* ------------------------------------------------------------------ */

/**
 * `id` is a UUIDv7 generated in application code — time-ordered so the index
 * does not fragment, with 74 random bits so it cannot be walked. Postgres 16
 * has no native uuidv7(), so there is deliberately no database default: the
 * caller must supply one.
 *
 * `ref` (ROT-0042) is the human label. It is per-client sequential and so
 * leaks how many jobs a client has — which is why it NEVER appears in a URL.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    ref: text("ref").notNull(),
    direction: jobDirection("direction").notNull(),
    title: text("title").notNull(),
    status: jobStatus("status").notNull().default("open"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    assignedTo: uuid("assigned_to").references(() => users.id),
    dueAt: timestamp("due_at", { withTimezone: true }),

    // Phase 2 — commercial. Defined now so the shape is agreed.
    poNumber: text("po_number"),
    quotedAmountCents: integer("quoted_amount_cents"),
    currency: char("currency", { length: 3 }),

    /**
     * Where this job's files live in Google Drive.
     *
     * A reference, not a copy: the portal records which folder belongs to which
     * job and nothing else. Drive stays the place the files are, so nobody has
     * to wonder which of two systems has the current version.
     *
     * Null until somebody asks for a folder. Creating one is deliberately an
     * action rather than something that happens to every request that arrives,
     * because most enquiries never become work and a Drive full of empty
     * folders is worse than no folders.
     */
    driveFolderId: text("drive_folder_id"),
    driveFolderUrl: text("drive_folder_url"),

    createdAt,
    updatedAt,
    /** The archive is a timestamp, not a second table to forget to scope. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_org_ref_idx").on(t.organizationId, t.ref),
    index("jobs_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

/**
 * Append-only. UPDATE and DELETE are revoked from the application role in the
 * migration, so this is enforced by the database rather than by convention.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Null for system actions. */
    actorId: uuid("actor_id").references(() => users.id),
    /** Email can change later; the record of who acted must not. */
    actorEmailAtTime: text("actor_email_at_time").notNull(),
    /**
     * The three columns below are the other half of `actor_id`, and they are
     * null on every ordinary row.
     *
     * While somebody is acting as somebody else, `actor_id` stays the person
     * the work was done AS — that is the point of the feature, and a client's
     * own history should read as their own work rather than as a stranger
     * rummaging in it. What that alone cannot say is that a human other than
     * the named one was at the keyboard. These say it.
     *
     * Null therefore means something exact: this was real work, done by the
     * person named in `actor_id`. Non-null means it was done while acting as
     * them, by `real_actor_id`, under the grant in `act_as_grant_id` — whose
     * row carries the reason that was typed. Six months from now that is the
     * difference between test data and a client's real history, and it cannot
     * be reconstructed later if it is not written now.
     *
     * `real_actor_email_at_time` is kept for the same reason
     * `actor_email_at_time` is: an address can change, and the record of who
     * acted must not.
     */
    realActorId: uuid("real_actor_id").references(() => users.id),
    realActorEmailAtTime: text("real_actor_email_at_time"),
    actAsGrantId: uuid("act_as_grant_id").references(() => actAsGrants.id),
    action: text("action").notNull(),
    /** Field-level diff, not a whole-row dump. */
    before: jsonb("before"),
    after: jsonb("after"),
    /** The server's clock, never the client's. */
    createdAt,
  },
  (t) => [index("job_events_job_idx").on(t.jobId)],
);

/**
 * Every table that belongs to a client carries `organization_id` directly —
 * deliberately denormalised — so the scoping helper and the database policies
 * apply one identical filter to every table with no joins.
 */
export const TENANT_SCOPED_TABLES = [
  "jobs",
  "job_events",
  "api_keys",
  "invitations",
] as const;
