import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { inTenantTransaction, type Transaction } from "./connection";
import { jobEvents, jobs, organizations } from "./schema";
import { uuidv7 } from "../ids";

/**
 * THE SHARED SCOPED HELPER.
 *
 * This is the only surface the application may use to reach client data. It is
 * impossible to call any of it without a scope, because the scope is the first
 * argument of every function — there is no unscoped variant to reach for in a
 * hurry, and `lib/db/connection.ts` is off-limits to every module outside this
 * directory (enforced by ESLint, so it fails the build rather than review).
 *
 * The scope is derived from the SESSION and nothing else. Never from a
 * hostname, a header, a query parameter or a form field. The host a request
 * arrived on decides branding; it carries no authority.
 *
 * Underneath this, Postgres enforces the same rule independently. That
 * duplication is deliberate: it catches the case this layer cannot, where a
 * nested relation load applies its own filter and quietly reaches across
 * tenants.
 */

export type Scope = {
  userId: string;
  /** Recorded on audit rows, because an address can change later. */
  email: string;
  isStaff: boolean;
  /**
   * The client being acted on. For a client user this is their own company.
   * For staff it is the company their current grant covers — null when they
   * are on the cross-client overview, which is read-only by construction.
   */
  organizationId: string | null;
};

/**
 * Is this session surveying every client, or acting on one?
 *
 * The cross-client read policy exists so staff can see the whole board. It must
 * apply ONLY while no client is chosen: Postgres combines permissive policies
 * with OR, so leaving the flag on while a grant is held would keep every other
 * client visible and make the grant decorative.
 *
 * With it off, a staff session holding a grant behaves exactly like a client
 * session — same connection, same role, same query, same rows. That sameness is
 * the point: it is what stops staff access becoming a second, less-travelled
 * code path where the bugs live.
 */
function isSurveying(scope: Scope): boolean {
  return scope.isStaff && scope.organizationId === null;
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/** Writes always need one specific client. Staff must hold a grant first. */
function requireWritableOrg(scope: Scope): string {
  if (!scope.organizationId) {
    throw new ScopeError(
      "This action writes to one client's data, and the current session is not " +
        "scoped to a client. Staff must choose a client and give a reason first.",
    );
  }
  return scope.organizationId;
}

export type JobRow = typeof jobs.$inferSelect;

/**
 * A client sees their own company's jobs. Staff see every client's.
 *
 * Both go down the identical path: same connection, same restricted role, same
 * query. The only difference is what the database policies admit — which is
 * written down in the migration and can be audited there, rather than being a
 * branch in application code that says `if (isAdmin) skipTheCheck()`.
 */
export async function listJobs(scope: Scope): Promise<JobRow[]> {
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select()
      .from(jobs)
      .orderBy(desc(jobs.createdAt))
      .limit(200),
  );
}

/**
 * Fetch one job by the id in the URL.
 *
 * There is deliberately no "find it, then check whether you're allowed" here.
 * The row is invisible to a caller outside its organization, so a client
 * guessing another client's id gets the same answer as for an id that never
 * existed: nothing. Not found and not allowed are indistinguishable, which is
 * what stops the endpoint confirming that someone else's job exists.
 */
export async function getJob(
  scope: Scope,
  jobId: string,
): Promise<JobRow | null> {
  const rows = await inTenantTransaction(
    scope.organizationId,
    isSurveying(scope),
    (tx) => tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1),
  );
  return rows[0] ?? null;
}

export type NewJob = {
  title: string;
  direction: "from_client" | "to_client";
  dueAt?: Date | null;
  assignedTo?: string | null;
  /**
   * Whatever the sender filled in, when the job arrived from a form rather than
   * from this application's own screens — a name, an address, what they want
   * quoting. It is kept on the creation event rather than in columns on `jobs`,
   * because it is a record of what was submitted at one moment and must not
   * drift as the job is worked on. The audit table is append-only at the
   * database, which is exactly the property that record needs.
   */
  details?: Record<string, string> | null;
};

export async function createJob(
  scope: Scope,
  input: NewJob,
): Promise<JobRow> {
  const organizationId = requireWritableOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const ref = await nextJobRef(tx, organizationId);
    const id = uuidv7();

    const [job] = await tx
      .insert(jobs)
      .values({
        id,
        organizationId,
        ref,
        title: input.title.trim(),
        direction: input.direction,
        status: "open",
        createdBy: scope.userId,
        assignedTo: input.assignedTo ?? null,
        dueAt: input.dueAt ?? null,
      })
      .returning();

    await recordEvent(tx, scope, job, "created", null, {
      title: job.title,
      direction: job.direction,
      status: job.status,
      ...(input.details ? { details: input.details } : {}),
    });

    return job;
  });
}

export async function setJobStatus(
  scope: Scope,
  jobId: string,
  status: JobRow["status"],
): Promise<JobRow | null> {
  const organizationId = requireWritableOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const before = (
      await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    )[0];
    if (!before) return null;

    const [after] = await tx
      .update(jobs)
      .set({ status, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();

    await recordEvent(
      tx,
      scope,
      after,
      "status_changed",
      { status: before.status },
      { status: after.status },
    );

    return after;
  });
}

/**
 * Per-client reference, allocated by incrementing and reading the counter in a
 * single statement so simultaneous callers cannot collide. The prefix comes
 * from the client's slug purely for readability — the reference is shown to
 * people and never appears in a URL, because being sequential it would
 * otherwise reveal how many jobs a client has.
 */
async function nextJobRef(
  tx: Transaction,
  organizationId: string,
): Promise<string> {
  const [org] = await tx
    .update(organizations)
    .set({ jobCounter: sql`${organizations.jobCounter} + 1` })
    .where(eq(organizations.id, organizationId))
    .returning({ slug: organizations.slug, counter: organizations.jobCounter });

  const prefix = org.slug.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase();
  return `${prefix || "JOB"}-${String(org.counter).padStart(4, "0")}`;
}

/**
 * Append-only audit. The application role holds INSERT and SELECT on this table
 * and nothing else, so an attempt to rewrite history fails as a database
 * permission error rather than relying on nobody writing that code.
 *
 * The diff is field-level rather than a whole-row dump, and the timestamp is
 * the server's — never a value the caller supplied.
 */
async function recordEvent(
  tx: Transaction,
  scope: Scope,
  job: JobRow,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx.insert(jobEvents).values({
    jobId: job.id,
    organizationId: job.organizationId,
    actorId: scope.userId,
    actorEmailAtTime: scope.email,
    action,
    before: before ?? null,
    after: after ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export type JobStats = {
  total: number;
  open: number;
  inProgress: number;
  completed: number;
  awaitingUs: number;
  oldestAwaitingDays: number | null;
  sentThisMonth: number;
  receivedThisMonth: number;
  byStatus: Array<{ status: string; n: number }>;
};

/**
 * The figures behind the dashboard, in one round trip.
 *
 * Every count goes through the same scoped transaction as everything else, so
 * a client's dashboard is arithmetic over their own rows and a staff overview
 * is arithmetic over all of them — without a second, differently-shaped query
 * that could disagree with the list it sits above.
 */
export async function jobStats(scope: Scope): Promise<JobStats> {
  return inTenantTransaction(
    scope.organizationId,
    isSurveying(scope),
    async (tx) => {
      const rows = await tx
        .select({
          status: jobs.status,
          direction: jobs.direction,
          n: sql<number>`count(*)::int`,
          oldest: sql<string | null>`min(${jobs.createdAt})`,
          thisMonth: sql<number>`count(*) filter (
            where ${jobs.createdAt} >= date_trunc('month', now())
          )::int`,
        })
        .from(jobs)
        .where(sql`${jobs.archivedAt} is null`)
        .groupBy(jobs.status, jobs.direction);

      const total = rows.reduce((sum, r) => sum + r.n, 0);
      const sum = (fn: (r: (typeof rows)[number]) => boolean) =>
        rows.filter(fn).reduce((s, r) => s + r.n, 0);

      const byStatusMap = new Map<string, number>();
      for (const r of rows) {
        byStatusMap.set(r.status, (byStatusMap.get(r.status) ?? 0) + r.n);
      }

      // "Awaiting a response" is work the other side sent in that nobody has
      // picked up — the number that should make someone act.
      const awaiting = rows.filter(
        (r) => r.direction === "from_client" && r.status === "open",
      );
      const oldest = awaiting
        .map((r) => (r.oldest ? new Date(r.oldest).getTime() : null))
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b)[0];

      return {
        total,
        open: sum((r) => r.status === "open"),
        inProgress: sum((r) => r.status === "in_progress"),
        completed: sum((r) => r.status === "completed"),
        awaitingUs: awaiting.reduce((s, r) => s + r.n, 0),
        oldestAwaitingDays:
          oldest === undefined
            ? null
            : Math.floor((Date.now() - oldest) / 86_400_000),
        sentThisMonth: rows
          .filter((r) => r.direction === "to_client")
          .reduce((s, r) => s + r.thisMonth, 0),
        receivedThisMonth: rows
          .filter((r) => r.direction === "from_client")
          .reduce((s, r) => s + r.thisMonth, 0),
        byStatus: [...byStatusMap.entries()]
          .map(([status, n]) => ({ status, n }))
          .sort((a, b) => b.n - a.n),
      };
    },
  );
}

export async function recentJobs(scope: Scope, limit = 6) {
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select({
        id: jobs.id,
        ref: jobs.ref,
        title: jobs.title,
        status: jobs.status,
        direction: jobs.direction,
        createdAt: jobs.createdAt,
        organizationId: jobs.organizationId,
        organizationName: organizations.name,
      })
      .from(jobs)
      .innerJoin(organizations, eq(organizations.id, jobs.organizationId))
      .orderBy(desc(jobs.createdAt))
      .limit(limit),
  );
}

/**
 * Per-person totals for the Team screen: what each person sent, what is
 * assigned to them, and when they were last involved in anything.
 *
 * Scoped like everything else, so a client sees their own colleagues' activity
 * and never another company's.
 */
export async function jobsPerPerson(scope: Scope) {
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select({
        userId: jobs.createdBy,
        sent: sql<number>`count(*) filter (where ${jobs.direction} = 'to_client')::int`,
        received: sql<number>`count(*) filter (where ${jobs.direction} = 'from_client')::int`,
        raised: sql<number>`count(*)::int`,
        lastActivity: sql<string | null>`max(${jobs.updatedAt})`,
      })
      .from(jobs)
      .groupBy(jobs.createdBy),
  );
}

export async function assignedPerPerson(scope: Scope) {
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select({
        userId: jobs.assignedTo,
        assigned: sql<number>`count(*)::int`,
      })
      .from(jobs)
      .where(sql`${jobs.assignedTo} is not null`)
      .groupBy(jobs.assignedTo),
  );
}

/**
 * How many jobs one account has filed recently.
 *
 * This is the rate limit behind the intake endpoint, and it is deliberately a
 * database count rather than a counter held in memory. The application runs as
 * more than one instance, and an in-memory limit is really one limit per
 * instance — so a limit of sixty becomes a limit of sixty times however many
 * containers happen to be running, which is a number nobody has written down.
 */
export async function jobsFiledSince(
  scope: Scope,
  creatorId: string,
  since: Date,
): Promise<number> {
  const rows = await inTenantTransaction(
    scope.organizationId,
    isSurveying(scope),
    (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(eq(jobs.createdBy, creatorId), sql`${jobs.createdAt} >= ${since}`),
        ),
  );
  return rows[0]?.n ?? 0;
}

export async function listJobEvents(scope: Scope, jobId: string) {
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(desc(jobEvents.createdAt))
      .limit(100),
  );
}

export { and, eq };
