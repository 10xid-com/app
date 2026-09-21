import "server-only";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { inTenantTransaction, type Transaction } from "./connection";
import { isQualified } from "./access";
import {
  departmentMembers,
  taskClaims,
  taskEvents,
  taskGrades,
  taskOffers,
  tasks,
  taskTypes,
} from "./schema";
import { uuidv7 } from "../ids";
import { ScopeError, type Scope } from "./index";

/**
 * FLOW — work bought in TOUCHES.
 *
 * The unit is not the job. It is one paid act by one person: quote, digitize,
 * approve. Everything here is scoped the same way `lib/db/index.ts` is scoped,
 * for the same reason — the scope is the first argument, there is no unscoped
 * variant to reach for, and Postgres enforces the same boundary underneath
 * through the policies in drizzle/0015_flow_task_spine.sql.
 *
 * WHAT THE DATABASE ENFORCES AND THIS FILE DOES NOT REPEAT:
 *
 *   * the allowed time, pinned at creation from the task type and the bands;
 *   * a claim's deadline, stamped from that pinned figure;
 *   * separation of duty across the rework chain.
 *
 * Those are triggers, on purpose. Every one of them would be bypassed by the
 * first repair script anybody writes, and the third one is the rule the whole
 * incentive design rests on.
 */

function requireOrg(scope: Scope): string {
  if (!scope.organizationId) {
    throw new ScopeError(
      "This action writes to one client's work, and the current session is " +
        "not scoped to a client. Staff must choose a client and give a reason first.",
    );
  }
  return scope.organizationId;
}

export type TaskRow = typeof tasks.$inferSelect;
export type TaskClaimRow = typeof taskClaims.$inferSelect;
export type TaskGradeRow = typeof taskGrades.$inferSelect;

/** One audit line. Append-only: the role holds INSERT and SELECT and no more. */
async function record(
  tx: Transaction,
  scope: Scope,
  taskId: string,
  action: string,
  detail: { before?: unknown; after?: unknown } = {},
  system = false,
) {
  await tx.insert(taskEvents).values({
    taskId,
    organizationId: requireOrg(scope),
    // Null on both, together, when nobody decided this — a claim timing out is
    // the clock's doing, and attributing it to whoever triggered the sweep
    // would be a lie in the one table that exists to be believed.
    actorId: system ? null : scope.userId,
    actorEmailAtTime: system ? null : scope.email,
    action,
    before: detail.before ?? null,
    after: detail.after ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* Kinds of work                                                       */
/* ------------------------------------------------------------------ */

export async function createTaskType(
  scope: Scope,
  input: {
    slug: string;
    name: string;
    stdMinutes: number;
    description?: string | null;
  },
) {
  const organizationId = requireOrg(scope);
  const rows = await inTenantTransaction(organizationId, false, (tx) =>
    tx
      .insert(taskTypes)
      .values({
        organizationId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        stdMinutes: input.stdMinutes,
      })
      .returning(),
  );
  return rows[0];
}

export async function listTaskTypes(scope: Scope) {
  return inTenantTransaction(scope.organizationId, false, (tx) =>
    tx.select().from(taskTypes).where(isNull(taskTypes.deletedAt)),
  );
}

/* ------------------------------------------------------------------ */
/* Touches                                                             */
/* ------------------------------------------------------------------ */

/**
 * Raise one touch.
 *
 * `stdMinutes` and `bufferMinutes` are DELIBERATELY NOT SET HERE. They are
 * filled by `flow_pin_allowed_time()` from the task type and from
 * `task_time_bands` at the moment of insert, and frozen against later edits by
 * `flow_freeze_allowed_time()`.
 *
 * Computing them in TypeScript instead would put the band lookup in two
 * places, and the one that is wrong would be the one a script uses. Reading
 * them from the type at CLAIM time instead would mean retuning a standard time
 * moves the deadline of work somebody is already holding — which is the exact
 * thing the README forbids.
 *
 * The cast is what lets those two columns be omitted: they are NOT NULL in the
 * database with no default, because the default is a trigger and Drizzle has
 * no way to say that.
 */
export async function createTask(
  scope: Scope,
  input: {
    jobId: string;
    taskTypeId: string;
    title?: string | null;
    /** The attempt this one replaces, when it is a rework. */
    parentTaskId?: string | null;
    /** The task this one exists to inspect, when it is an approval touch. */
    approvesTaskId?: string | null;
    status?: TaskRow["status"];
  },
): Promise<TaskRow> {
  const organizationId = requireOrg(scope);
  const id = uuidv7();

  return inTenantTransaction(organizationId, false, async (tx) => {
    const rows = await tx
      .insert(tasks)
      .values({
        id,
        organizationId,
        jobId: input.jobId,
        taskTypeId: input.taskTypeId,
        title: input.title ?? null,
        parentTaskId: input.parentTaskId ?? null,
        approvesTaskId: input.approvesTaskId ?? null,
        status: input.status ?? "open",
        createdBy: scope.userId,
      } as typeof tasks.$inferInsert)
      .returning();

    const task = rows[0];
    await record(tx, scope, task.id, "task.created", {
      after: {
        taskTypeId: task.taskTypeId,
        status: task.status,
        stdMinutes: task.stdMinutes,
        bufferMinutes: task.bufferMinutes,
        allowedMinutes: task.allowedMinutes,
      },
    });
    return task;
  });
}

export async function getTask(scope: Scope, taskId: string) {
  const rows = await inTenantTransaction(scope.organizationId, false, (tx) =>
    tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1),
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Offers                                                              */
/* ------------------------------------------------------------------ */

export async function offerTask(
  scope: Scope,
  input:
    | { taskId: string; to: "user"; userId: string }
    | { taskId: string; to: "department"; departmentId: string }
    | {
        taskId: string;
        to: "qualification";
        taskTypeId: string;
        minLevel: number;
      },
) {
  const organizationId = requireOrg(scope);
  return inTenantTransaction(organizationId, false, async (tx) => {
    const rows = await tx
      .insert(taskOffers)
      .values({
        organizationId,
        taskId: input.taskId,
        offereeType: input.to,
        userId: input.to === "user" ? input.userId : null,
        departmentId: input.to === "department" ? input.departmentId : null,
        qualificationTaskTypeId:
          input.to === "qualification" ? input.taskTypeId : null,
        minQualificationLevel:
          input.to === "qualification" ? input.minLevel : null,
        createdBy: scope.userId,
      })
      .returning();
    await record(tx, scope, input.taskId, "task.offered", { after: rows[0] });
    return rows[0];
  });
}

/**
 * Is this task available to this person?
 *
 * Three shapes of offer, one answer. The qualification case resolves through
 * `lib/db/access.ts` rather than through a second qualifications table, which
 * is the whole reason the level lives on `permissions`.
 *
 * This is an application-layer convenience and NOT the guard on claiming. The
 * guard that matters — separation of duty — is in the database, because this
 * one is exactly the kind of check a script goes around.
 */
export async function isOfferedTo(
  scope: Scope,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const organizationId = requireOrg(scope);

  const offers = await inTenantTransaction(organizationId, false, (tx) =>
    tx
      .select()
      .from(taskOffers)
      .where(and(eq(taskOffers.taskId, taskId), isNull(taskOffers.revokedAt))),
  );

  for (const offer of offers) {
    if (offer.offereeType === "user" && offer.userId === userId) return true;

    if (offer.offereeType === "department" && offer.departmentId) {
      const rows = await inTenantTransaction(organizationId, false, (tx) =>
        tx
          .select({ id: departmentMembers.id })
          .from(departmentMembers)
          .where(
            and(
              eq(departmentMembers.departmentId, offer.departmentId!),
              eq(departmentMembers.userId, userId),
            ),
          )
          .limit(1),
      );
      if (rows.length > 0) return true;
    }

    if (
      offer.offereeType === "qualification" &&
      offer.qualificationTaskTypeId &&
      (await isQualified(
        organizationId,
        userId,
        offer.qualificationTaskTypeId,
        offer.minQualificationLevel ?? 2,
      ))
    ) {
      return true;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Attempts                                                            */
/* ------------------------------------------------------------------ */

/**
 * TAKE THE JOB. One conditional statement decides the race.
 *
 *   UPDATE tasks SET status = 'claimed' WHERE id = $1 AND status = 'open'
 *
 * Zero rows back means somebody else got there first, and that is the ONLY
 * thing that means it. The read-then-write version of this — select the task,
 * see that it is open, insert a claim — has a window between the two halves in
 * which both callers see `open`, and two people spend an afternoon on the same
 * work believing it is theirs. The window is small, which is worse than large:
 * it will not show up in testing and will show up on the first busy morning.
 *
 * Under READ COMMITTED the second transaction blocks on the row lock until the
 * first commits, then re-evaluates its WHERE against the committed row, finds
 * `claimed`, and updates nothing. There is no configuration in which both win.
 *
 * The partial unique index `task_claims_one_live_idx` is the belt to this
 * brace: even a caller that skipped the UPDATE entirely could not write a
 * second live claim.
 */
export async function claimTask(
  scope: Scope,
  input: { taskId: string; userId: string },
): Promise<TaskClaimRow | null> {
  const organizationId = requireOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const won = await tx
      .update(tasks)
      .set({ status: "claimed", updatedAt: new Date() })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.status, "open")))
      .returning({ id: tasks.id });

    if (won.length === 0) return null;

    // expiresAt is omitted: flow_stamp_claim_window() fills it from the task's
    // PINNED allowed minutes. Same reasoning as createTask.
    const rows = await tx
      .insert(taskClaims)
      .values({
        organizationId,
        taskId: input.taskId,
        userId: input.userId,
      } as typeof taskClaims.$inferInsert)
      .returning();

    await record(tx, scope, input.taskId, "claim.taken", {
      before: { status: "open" },
      after: { status: "claimed", claimId: rows[0].id, userId: input.userId },
    });
    return rows[0];
  });
}

/**
 * HAND IT BACK, on purpose, before the clock runs out.
 *
 * Recorded as `released`, which is a different outcome from `expired` and must
 * stay that way. If a clean release and a silent abandonment looked the same
 * in the record there would be no reason to ever release — you may as well sit
 * on it and hope — and the behaviour the whole design wants here only appears
 * if the system can tell the two apart.
 *
 * Conditional, like claiming: only the live claim, only by the person holding
 * it. A release that raced an expiry sweep must lose cleanly rather than
 * overwriting the outcome the sweep already wrote.
 */
export async function releaseClaim(
  scope: Scope,
  input: { claimId: string; userId: string; note?: string | null },
): Promise<TaskClaimRow | null> {
  const organizationId = requireOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const rows = await tx
      .update(taskClaims)
      .set({
        outcome: "released",
        outcomeAt: new Date(),
        note: input.note ?? null,
      })
      .where(
        and(
          eq(taskClaims.id, input.claimId),
          eq(taskClaims.userId, input.userId),
          isNull(taskClaims.outcome),
        ),
      )
      .returning();

    if (rows.length === 0) return null;

    await tx
      .update(tasks)
      .set({ status: "open", updatedAt: new Date() })
      .where(eq(tasks.id, rows[0].taskId));

    await record(tx, scope, rows[0].taskId, "claim.released", {
      before: { status: "claimed" },
      after: { status: "open", claimId: rows[0].id, note: input.note ?? null },
    });
    return rows[0];
  });
}

/** Hand it in. The work exists and is waiting to be graded. */
export async function submitClaim(
  scope: Scope,
  input: { claimId: string; userId: string },
): Promise<TaskClaimRow | null> {
  const organizationId = requireOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const rows = await tx
      .update(taskClaims)
      .set({ outcome: "submitted", outcomeAt: new Date() })
      .where(
        and(
          eq(taskClaims.id, input.claimId),
          eq(taskClaims.userId, input.userId),
          isNull(taskClaims.outcome),
        ),
      )
      .returning();

    if (rows.length === 0) return null;

    await tx
      .update(tasks)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(eq(tasks.id, rows[0].taskId));

    await record(tx, scope, rows[0].taskId, "claim.submitted", {
      after: { status: "submitted", claimId: rows[0].id },
    });
    return rows[0];
  });
}

/**
 * THE CLOCK RAN OUT. Pull the claim and put the work back in the pool.
 *
 * Deliberately harsh, and the README says why in plain words: what cannot
 * happen is somebody taking a fifteen-minute job, taking the weekend off, and
 * leaving a client waiting until Tuesday. At ninety per cent complete it still
 * goes back.
 *
 * Nobody decides this, so the audit rows carry no actor. It is written as a
 * sweep rather than as a timer per claim because a timer that does not fire
 * leaves a task held forever, and a sweep that does not run leaves it held
 * until the next one does.
 */
export async function expireOverdueClaims(scope: Scope): Promise<number> {
  const organizationId = requireOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const rows = await tx
      .update(taskClaims)
      .set({ outcome: "expired", outcomeAt: new Date() })
      .where(
        and(
          isNull(taskClaims.outcome),
          lte(taskClaims.expiresAt, sql`now()`),
        ),
      )
      .returning();

    for (const claim of rows) {
      await tx
        .update(tasks)
        .set({ status: "open", updatedAt: new Date() })
        .where(and(eq(tasks.id, claim.taskId), eq(tasks.status, "claimed")));

      await record(
        tx,
        scope,
        claim.taskId,
        "claim.expired",
        {
          before: { status: "claimed", claimId: claim.id },
          after: { status: "open", expiresAt: claim.expiresAt },
        },
        true,
      );
    }

    return rows.length;
  });
}

export async function listClaims(scope: Scope, taskId: string) {
  return inTenantTransaction(scope.organizationId, false, (tx) =>
    tx.select().from(taskClaims).where(eq(taskClaims.taskId, taskId)),
  );
}

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Satisfactory or not, with an optional score and a note.
 *
 * The separation-of-duty trigger fires on this insert. It will refuse a grader
 * who did the work, a grader at the doer's company, and — through the rework
 * chain — a grader who did an earlier attempt at the same task. That refusal
 * arrives here as a database error and is deliberately not caught: a caller
 * that swallowed it would be a caller that reports a grade nobody may give.
 */
export async function gradeTask(
  scope: Scope,
  input: {
    taskId: string;
    claimId?: string | null;
    graderUserId: string;
    verdict: "satisfactory" | "unsatisfactory";
    score?: number | null;
    note?: string | null;
  },
): Promise<TaskGradeRow> {
  const organizationId = requireOrg(scope);

  return inTenantTransaction(organizationId, false, async (tx) => {
    const rows = await tx
      .insert(taskGrades)
      .values({
        organizationId,
        taskId: input.taskId,
        claimId: input.claimId ?? null,
        graderUserId: input.graderUserId,
        verdict: input.verdict,
        score: input.score ?? null,
        note: input.note ?? null,
      })
      .returning();

    await tx
      .update(tasks)
      .set({
        status: input.verdict === "satisfactory" ? "approved" : "rejected",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, input.taskId));

    await record(tx, scope, input.taskId, "task.graded", {
      after: {
        verdict: input.verdict,
        score: input.score ?? null,
        graderUserId: input.graderUserId,
      },
    });
    return rows[0];
  });
}

/**
 * The second attempt: a NEW row pointing back at the one it replaces.
 *
 * Not a reset of the rejected row, and not a status it recovers from. Two
 * attempts are two facts, they may be held by two different people, and each
 * gets its own full window rather than the remains of the other's. The link is
 * what the separation-of-duty trigger walks to find the person who rejected
 * the first attempt and refuse them this one.
 */
export async function openRework(
  scope: Scope,
  input: { parentTaskId: string; title?: string | null },
): Promise<TaskRow> {
  const parent = await getTask(scope, input.parentTaskId);
  if (!parent) {
    throw new ScopeError(
      "There is no such task in this client's work to rework.",
    );
  }
  return createTask(scope, {
    jobId: parent.jobId,
    taskTypeId: parent.taskTypeId,
    title: input.title ?? parent.title,
    parentTaskId: parent.id,
  });
}
