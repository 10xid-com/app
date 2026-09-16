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
