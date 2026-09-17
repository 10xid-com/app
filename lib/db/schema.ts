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
] as const;
