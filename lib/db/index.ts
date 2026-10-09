import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { inTenantTransaction, type Transaction } from "./connection";
import { jobEvents, jobNotes, jobs, organizations } from "./schema";
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
export async function listJobs(
  scope: Scope,
  opts: { assignedTo?: string; kind?: JobRow["kind"] } = {},
): Promise<JobRow[]> {
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select()
      .from(jobs)
      .where(
        and(
          opts.assignedTo ? eq(jobs.assignedTo, opts.assignedTo) : undefined,
          opts.kind ? eq(jobs.kind, opts.kind) : undefined,
        ),
      )
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
  /** Quote, estimate or job (login's 0033). A job unless said otherwise. */
  kind?: JobRow["kind"];
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
        kind: input.kind ?? "job",
        status: "open",
        createdBy: scope.userId,
        assignedTo: input.assignedTo ?? null,
        dueAt: input.dueAt ?? null,
      })
      .returning();

    await recordEvent(tx, scope, job, "created", null, {
      title: job.title,
      direction: job.direction,
      kind: job.kind,
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
  from: JobRow["status"],
): Promise<JobRow | null> {
  const organizationId = requireWritableOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    // Locked, and compared with the status the person was looking at: which
    // moves are allowed depends on where the job is (approving, or undoing an
    // approval, is a manager's), so a change made against a status that has
    // since moved on is not applied.
    const before = (
      await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).for("update")
    )[0];
    if (!before || before.status !== from) return null;

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

/* ------------------------------------------------------------------ */
/* Passing work around: notes, and handing a job to a teammate         */
/* ------------------------------------------------------------------ */

export type JobNoteRow = typeof jobNotes.$inferSelect;

/** What the people of the business have said about a job, oldest first. */
export async function listJobNotes(scope: Scope, jobId: string): Promise<JobNoteRow[]> {
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select()
      .from(jobNotes)
      .where(eq(jobNotes.jobId, jobId))
      .orderBy(asc(jobNotes.createdAt), asc(jobNotes.id))
      .limit(500),
  );
}

async function insertNote(
  tx: Transaction,
  scope: Scope,
  job: JobRow,
  body: string,
  handedTo: string | null,
): Promise<JobNoteRow> {
  const [note] = await tx
    .insert(jobNotes)
    .values({
      id: uuidv7(),
      jobId: job.id,
      organizationId: job.organizationId,
      authorId: scope.userId,
      authorEmailAtTime: scope.email,
      body: body.trim(),
      handedTo,
    })
    .returning();
  return note;
}

/**
 * Write a note on a job. Append-only at the database (login's 0031), which
 * also refuses a note on a job of another business: the job is read under
 * row-level security, so it is simply not there. Null when it is not.
 */
export async function addJobNote(
  scope: Scope,
  jobId: string,
  body: string,
): Promise<JobNoteRow | null> {
  const organizationId = requireWritableOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const job = (await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1))[0];
    if (!job) return null;
    return insertNote(tx, scope, job, body, null);
  });
}

export type Handover = { job: JobRow; note: JobNoteRow | null };

/**
 * Give a job to a person of the business, or take it off whoever has it
 * (`to` null), with an optional note that goes with it.
 *
 * Locked, and compared with who the person was looking at as the holder
 * (`from`): two people handing the same job at once must not both win, and
 * the second has made their choice about a job that has since moved on. Null
 * then, and nothing is written. The database refuses a `to` who is not a
 * person of the job's business (0031).
 */
export async function handOverJob(
  scope: Scope,
  jobId: string,
  input: { to: string | null; from: string | null; note?: string | null },
): Promise<Handover | null> {
  const organizationId = requireWritableOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const before = (
      await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).for("update")
    )[0];
    if (!before || before.assignedTo !== input.from) return null;

    const [after] = await tx
      .update(jobs)
      .set({ assignedTo: input.to, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();

    await recordEvent(
      tx,
      scope,
      after,
      input.to ? "handed_over" : "unassigned",
      { assignedTo: before.assignedTo },
      { assignedTo: after.assignedTo },
    );

    const body = input.note?.trim();
    const note = body ? await insertNote(tx, scope, after, body, input.to) : null;

    return { job: after, note };
  });
}

/**
 * Make a job a quote, an estimate or a job — a quote the customer accepts
 * becomes a job. Like a status change: locked, applied only if the job is
 * still the kind the person was looking at, and recorded in its history.
 */
export async function setJobKind(
  scope: Scope,
  jobId: string,
  kind: JobRow["kind"],
  from: JobRow["kind"],
): Promise<JobRow | null> {
  const organizationId = requireWritableOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const before = (
      await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).for("update")
    )[0];
    if (!before || before.kind !== from) return null;

    const [after] = await tx
      .update(jobs)
      .set({ kind, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();

    await recordEvent(tx, scope, after, "kind_changed", { kind: before.kind }, { kind: after.kind });
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
    // real_actor_id, real_actor_email_at_time and act_as_grant_id stay null:
    // they belonged to Act as, which is retired. The columns keep its history.
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

export type RequestCard = {
  id: string;
  ref: string;
  title: string;
  status: JobRow["status"];
  createdAt: Date;
  organizationId: string;
  organizationName: string;
  driveFolderId: string | null;
  driveFolderUrl: string | null;
  details: Record<string, string> | null;
};

/**
 * What came in, with what the sender actually wrote.
 *
 * A request is work arriving from the client's side — an estimate enquiry off
 * their website, or a job somebody raised in the portal. The submitted details
 * are read off the creation event rather than from columns on `jobs`, because
 * they are a record of one moment and must not drift as the job is worked on.
 * The audit table cannot be rewritten by the application role, which is exactly
 * the property that record needs.
 *
 * One query rather than a fetch-then-loop: a card list that issues a second
 * query per card is the thing that quietly turns one page load into forty.
 */
export async function recentRequests(
  scope: Scope,
  limit = 12,
): Promise<RequestCard[]> {
  const rows = await inTenantTransaction(
    scope.organizationId,
    isSurveying(scope),
    (tx) =>
      tx
        .select({
          id: jobs.id,
          ref: jobs.ref,
          title: jobs.title,
          status: jobs.status,
          createdAt: jobs.createdAt,
          organizationId: jobs.organizationId,
          organizationName: organizations.name,
          driveFolderId: jobs.driveFolderId,
          driveFolderUrl: jobs.driveFolderUrl,
          details: sql<unknown>`(
            select e.after -> 'details'
              from job_events e
             where e.job_id = ${jobs.id} and e.action = 'created'
             order by e.id asc
             limit 1
          )`,
        })
        .from(jobs)
        .innerJoin(organizations, eq(organizations.id, jobs.organizationId))
        .where(
          and(
            eq(jobs.direction, "from_client"),
            sql`${jobs.archivedAt} is null`,
          ),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(limit),
  );

  return rows.map((row) => ({ ...row, details: narrowDetails(row.details) }));
}

/**
 * The details column is jsonb, so what comes back is whatever was written.
 * This narrows it rather than trusting it — every value is rendered as text,
 * because by definition some of it was typed by an anonymous member of the
 * public into a form on a website.
 */
function narrowDetails(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null) return null;
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Record which Drive folder belongs to this job.
 *
 * Scoped like every other write, so a folder cannot be attached to another
 * client's job — and the event is appended, so "who filed this away and when"
 * survives in the same place as everything else about the job.
 */
export async function attachDriveFolder(
  scope: Scope,
  jobId: string,
  folder: { id: string; url: string },
): Promise<JobRow | null> {
  const organizationId = requireWritableOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const [after] = await tx
      .update(jobs)
      .set({
        driveFolderId: folder.id,
        driveFolderUrl: folder.url,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, jobId), isNull(jobs.driveFolderId)))
      .returning();

    // Already had one. Not an error — two people pressed the button — but
    // nothing is overwritten and no second event is written.
    if (!after) return null;

    await recordEvent(tx, scope, after, "drive_folder_created", null, {
      driveFolderUrl: folder.url,
    });

    return after;
  });
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

/**
 * Find jobs by words in the title or by reference, for the workspace's
 * read-only job tools. Scoped exactly like listJobs: the database decides
 * which client's rows exist. `text` is matched with ILIKE and its wildcards
 * escaped, so a model cannot widen the search by sending `%`.
 */
export async function searchJobs(
  scope: Scope,
  opts: { text?: string; status?: JobRow["status"]; limit?: number },
) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const text = opts.text?.trim();
  const pattern = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx
      .select({
        id: jobs.id,
        ref: jobs.ref,
        title: jobs.title,
        status: jobs.status,
        direction: jobs.direction,
        promisedAt: jobs.promisedAt,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(
        and(
          isNull(jobs.archivedAt),
          opts.status ? eq(jobs.status, opts.status) : undefined,
          pattern
            ? sql`(${jobs.title} ILIKE ${pattern} ESCAPE '\\' OR ${jobs.ref} ILIKE ${pattern} ESCAPE '\\')`
            : undefined,
        ),
      )
      .orderBy(desc(jobs.updatedAt))
      .limit(limit),
  );
}

/** One job by its human reference (ROT-0042), scoped like getJob. */
export async function getJobByRef(scope: Scope, ref: string): Promise<JobRow | null> {
  const rows = await inTenantTransaction(scope.organizationId, isSurveying(scope), (tx) =>
    tx.select().from(jobs).where(eq(jobs.ref, ref.toUpperCase())).limit(1),
  );
  return rows[0] ?? null;
}

export { and, eq };
