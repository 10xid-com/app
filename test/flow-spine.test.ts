import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { closePool } from "@/lib/db/connection";
import type { Scope } from "@/lib/db";
import {
  QUALIFICATION_LEVELS,
  qualificationLevel,
  qualify,
  disqualify,
} from "@/lib/db/access";
import {
  claimTask,
  createTask,
  createTaskType,
  expireOverdueClaims,
  gradeTask,
  getTask,
  isOfferedTo,
  listClaims,
  offerTask,
  openRework,
  releaseClaim,
  submitClaim,
} from "@/lib/db/flow";

/**
 * FLOW, FIRST SLICE — the rules, proved against a real database.
 *
 * These tests are not about whether the columns exist. They are about the four
 * things docs/flow/README.md says will otherwise go wrong, each of which is
 * enforced by Postgres rather than by this application:
 *
 *   * two people claiming at once produce exactly ONE winner;
 *   * a clean release and a timeout are DIFFERENT facts;
 *   * the person who does the work cannot approve it, nor can their colleague,
 *     nor can the approver double back and claim the rework;
 *   * the allowed time is pinned at creation and does not move when the bands
 *     are revised afterwards.
 *
 * Fixtures are built here rather than taken from the seed, because the shape
 * these need — a client whose job it is, and workers at two OTHER companies —
 * is exactly the shape separation of duty is about, and borrowing rows whose
 * memberships somebody else maintains would make a passing test mean nothing.
 */

/**
 * What did the database actually refuse with?
 *
 * Drizzle wraps a query failure in an error whose message is the SQL it sent,
 * with the real message from Postgres hidden in `cause`. Asserting on
 * `.rejects.toThrow(/.../)` would therefore be asserting about the query text
 * — it would pass for a typo as readily as for a refusal. This walks the chain
 * and returns everything that was said, so a test can match the rule it means.
 */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const said: string[] = [];
    let e: unknown = err;
    while (e instanceof Error) {
      said.push(e.message);
      e = (e as { cause?: unknown }).cause;
    }
    return said.join(" | ");
  }
  throw new Error("expected the database to refuse this, and it did not");
}

const owner = new Client({ connectionString: process.env.DATABASE_URL });

const ids = {
  client: "",
  shop: "",
  studio: "",
  manager: "",
  worker: "",
  mate: "", // worker's colleague — same company as `worker`
  rival: "", // a worker at a third company
  approver: "",
  job: "",
  digitize: "",
  approveType: "",
  department: "",
};

let scope: Scope;

const org = async (slug: string, name: string, type = "client") => {
  const { rows } = await owner.query(
    `insert into organizations (type, name, slug) values ($1,$2,$3) returning id`,
    [type, name, slug],
  );
  return rows[0].id as string;
};

const person = async (email: string, name: string, orgId: string) => {
  const { rows } = await owner.query(
    `insert into users (email, full_name, email_verified_at)
     values ($1,$2, now()) returning id`,
    [email, name],
  );
  const id = rows[0].id as string;
  await owner.query(
    `insert into memberships (user_id, organization_id, role) values ($1,$2,'member')`,
    [id, orgId],
  );
  return id;
};

/**
 * Leave nothing behind, and start from nothing.
 *
 * Run before AND after, because a run that dies halfway through leaves
 * fixtures that would make the next run fail on a unique index rather than on
 * whatever actually broke — and a test that cannot say why it failed is worse
 * than no test.
 */
async function purge() {
  const orgs = `(select id from organizations where slug like 'flowtest-%')`;
  const people = `(select id from users where email like '%@flowtest.test')`;
  for (const statement of [
    `delete from task_events where organization_id in ${orgs}`,
    `delete from task_grades where organization_id in ${orgs}`,
    `delete from task_claims where organization_id in ${orgs}`,
    `delete from task_offers where organization_id in ${orgs}`,
    // Tasks point at tasks, so they come off in dependency order.
    `delete from tasks where organization_id in ${orgs} and approves_task_id is not null`,
    `delete from tasks where organization_id in ${orgs} and parent_task_id is not null`,
    `delete from tasks where organization_id in ${orgs}`,
    `delete from task_types where organization_id in ${orgs}`,
    `delete from permissions where organization_id in ${orgs}`,
    `delete from department_members where organization_id in ${orgs}`,
    `delete from departments where organization_id in ${orgs}`,
    `delete from job_events where organization_id in ${orgs}`,
    `delete from jobs where organization_id in ${orgs}`,
    `delete from memberships where user_id in ${people}`,
    // Written by a trigger when the account was created, not by us.
    `delete from user_emails where user_id in ${people}`,
    `delete from identities where user_id in ${people}`,
    `delete from users where email like '%@flowtest.test'`,
    `delete from organizations where slug like 'flowtest-%'`,
  ]) {
    await owner.query(statement);
  }
}

beforeAll(async () => {
  await owner.connect();
  await purge();

  ids.client = await org("flowtest-client", "Flowtest Client");
  ids.shop = await org("flowtest-shop", "Flowtest Digitising Shop");
  ids.studio = await org("flowtest-studio", "Flowtest Studio");
  const third = await org("flowtest-third", "Flowtest Third Party");

  ids.manager = await person("manager@flowtest.test", "Manager", ids.client);
  ids.worker = await person("worker@flowtest.test", "Worker", ids.shop);
  ids.mate = await person("mate@flowtest.test", "Worker's colleague", ids.shop);
  ids.rival = await person("rival@flowtest.test", "Another shop", third);
  ids.approver = await person("approver@flowtest.test", "Approver", ids.studio);

  const { rows: jobRows } = await owner.query(
    `insert into jobs (id, organization_id, ref, direction, title, created_by, promised_at)
     values (gen_random_uuid(), $1, 'FLW-0001', 'from_client', 'Cap logo', $2, now() + interval '2 days')
     returning id`,
    [ids.client, ids.manager],
  );
  ids.job = jobRows[0].id;

  const { rows: deptRows } = await owner.query(
    `insert into departments (organization_id, name, slug)
     values ($1,'Digitising','flowtest-digitising') returning id`,
    [ids.client],
  );
  ids.department = deptRows[0].id;

  scope = {
    userId: ids.manager,
    email: "manager@flowtest.test",
    isStaff: false,
    organizationId: ids.client,
  };

  ids.digitize = (
    await createTaskType(scope, {
      slug: "digitize",
      name: "Digitize",
      stdMinutes: 10,
    })
  )!.id;

  ids.approveType = (
    await createTaskType(scope, {
      slug: "approve",
      name: "Approve",
      stdMinutes: 3,
    })
  )!.id;
});

afterAll(async () => {
  await purge();
  await owner.end();
  await closePool();
});

/* ------------------------------------------------------------------ */

describe("the two clocks", () => {
  test("the bands are rows, and they produce the README's worked examples", async () => {
    const { rows } = await owner.query(
      `select flow_buffer_minutes(3) as three,
              flow_buffer_minutes(19) as nineteen,
              flow_buffer_minutes(20) as twenty,
              flow_buffer_minutes(40) as forty,
              flow_buffer_minutes(41) as fortyone,
              flow_buffer_minutes(60) as hour`,
    );
    const b = rows[0];
    // "A three-minute quote is therefore allowed eight minutes."
    expect(b.three).toBe(5);
    expect(b.nineteen).toBe(5);
    expect(b.twenty).toBe(10);
    expect(b.forty).toBe(10);
    expect(b.fortyone).toBe(15);
    // "A one-hour digitise is allowed an hour and fifteen."
    expect(b.hour).toBe(15);
  });

  test("the worker's window and the client's promise are different columns", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Two clocks",
    });
    const { rows } = await owner.query(
      `select promised_at from jobs where id = $1`,
      [ids.job],
    );
    // The worker gets 15 minutes. The client was promised two days. Neither
    // number is derived from the other, and that is the point.
    expect(task.allowedMinutes).toBe(15);
    expect(rows[0].promised_at.getTime()).toBeGreaterThan(Date.now() + 36e5);
  });

  test("the allowed time is pinned at creation and revising the bands does not move it", async () => {
    const before = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Created under the old bands",
    });
    expect([before.stdMinutes, before.bufferMinutes, before.allowedMinutes])
      .toEqual([10, 5, 15]);

    try {
      // Somebody revises the policy. The README expects this to happen.
      await owner.query(
        `update task_time_bands set buffer_minutes = 99
          where min_std_minutes = 0 and deleted_at is null`,
      );

      const unmoved = await getTask(scope, before.id);
      expect(unmoved!.bufferMinutes).toBe(5);
      expect(unmoved!.allowedMinutes).toBe(15);

      // ...and work created AFTER the change picks the new band up, which is
      // what makes the first assertion meaningful rather than a table nobody
      // reads.
      const after = await createTask(scope, {
        jobId: ids.job,
        taskTypeId: ids.digitize,
        title: "Created under the new bands",
      });
      expect(after.bufferMinutes).toBe(99);
    } finally {
      await owner.query(
        `update task_time_bands set buffer_minutes = 5
          where min_std_minutes = 0 and deleted_at is null`,
      );
    }
  });

  test("retuning a task type does not move work already in flight", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Pinned against a retune",
    });
    await owner.query(`update task_types set std_minutes = 45 where id = $1`, [
      ids.digitize,
    ]);
    try {
      const unmoved = await getTask(scope, task.id);
      expect(unmoved!.stdMinutes).toBe(10);

      const later = await createTask(scope, {
        jobId: ids.job,
        taskTypeId: ids.digitize,
        title: "Raised after the retune",
      });
      expect([later.stdMinutes, later.bufferMinutes]).toEqual([45, 15]);
    } finally {
      await owner.query(`update task_types set std_minutes = 10 where id = $1`, [
        ids.digitize,
      ]);
    }
  });

  test("a pin that could be edited would not be a pin", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Frozen",
    });
    expect(await refusal(
      owner.query(`update tasks set buffer_minutes = 600 where id = $1`, [
        task.id,
      ]),
    )).toMatch(/pinned at creation/);
  });
});

/* ------------------------------------------------------------------ */

describe("the claim race", () => {
  test("two people claiming at the same moment produce exactly one winner", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Contested",
    });

    // Six attempts fired at once, by four different people. Not two, because
    // two can pass by scheduling luck on a quiet machine.
    const attempts = [
      ids.worker,
      ids.rival,
      ids.mate,
      ids.approver,
      ids.worker,
      ids.rival,
    ].map((userId) => claimTask(scope, { taskId: task.id, userId }));

    const winners = (await Promise.all(attempts)).filter((c) => c !== null);
    expect(winners).toHaveLength(1);

    // And the database agrees, which is the claim that matters: one live row,
    // not one truthy return value.
    const claims = await listClaims(scope, task.id);
    expect(claims).toHaveLength(1);
    expect(claims[0].outcome).toBeNull();
    expect((await getTask(scope, task.id))!.status).toBe("claimed");
  });

  test("the conditional update is what serialises them, and the obvious alternative does not", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Two transactions, one task",
    });

    // Two real transactions, driven by hand, so the ordering is the test's
    // rather than the scheduler's.
    const first = new Client({ connectionString: process.env.DATABASE_URL });
    const second = new Client({ connectionString: process.env.DATABASE_URL });
    await first.connect();
    await second.connect();

    try {
      await first.query("begin");
      await second.query("begin");

      // THE BUG, in two lines: the read-then-write version of claiming reads
      // the status, sees `open`, and goes on to write a claim. Both
      // transactions see `open` here, and both would write one.
      const seenByFirst = await first.query(
        `select status from tasks where id = $1`,
        [task.id],
      );
      const seenBySecond = await second.query(
        `select status from tasks where id = $1`,
        [task.id],
      );
      expect(seenByFirst.rows[0].status).toBe("open");
      expect(seenBySecond.rows[0].status).toBe("open");

      // THE FIX: one conditional statement. The first takes the row lock.
      const wonByFirst = await first.query(
        `update tasks set status = 'claimed' where id = $1 and status = 'open' returning id`,
        [task.id],
      );
      expect(wonByFirst.rowCount).toBe(1);

      // The second issues the identical statement and BLOCKS — it does not
      // proceed on the stale read it already holds.
      const blocked = second.query(
        `update tasks set status = 'claimed' where id = $1 and status = 'open' returning id`,
        [task.id],
      );
      await first.query("commit");

      // Once the first commits, the second re-evaluates its WHERE against the
      // committed row, finds `claimed`, and updates nothing. Zero rows is the
      // only thing "you lost" ever means.
      const wonBySecond = await blocked;
      expect(wonBySecond.rowCount).toBe(0);
      await second.query("commit");
    } finally {
      await first.end();
      await second.end();
    }
  });

  test("a second live claim cannot be written even around the conditional update", async () => {
    // The belt to the brace: a caller that skipped the UPDATE entirely still
    // cannot put two people on one task.
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Belt and brace",
    });
    await claimTask(scope, { taskId: task.id, userId: ids.worker });

    expect(await refusal(
      owner.query(
        `insert into task_claims (organization_id, task_id, user_id, expires_at)
         values ($1,$2,$3, now() + interval '15 minutes')`,
        [ids.client, task.id, ids.rival],
      ),
    )).toMatch(/task_claims_one_live_idx/);
  });
});

/* ------------------------------------------------------------------ */

describe("giving a job back is not the same as losing it", () => {
  test("a release and an expiry are recorded distinguishably", async () => {
    const released = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Handed back",
    });
    const timedOut = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Sat on",
    });

    const heldA = await claimTask(scope, {
      taskId: released.id,
      userId: ids.worker,
    });
    const heldB = await claimTask(scope, {
      taskId: timedOut.id,
      userId: ids.worker,
    });

    // One worker knows at minute three that they cannot finish, and says so.
    const handedBack = await releaseClaim(scope, {
      claimId: heldA!.id,
      userId: ids.worker,
      note: "Cannot finish — my child is ill",
    });

    // The other simply stops. Their window runs out.
    await owner.query(
      `update task_claims
          set claimed_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        where id = $1`,
      [heldB!.id],
    );
    const swept = await expireOverdueClaims(scope);
    expect(swept).toBe(1);

    const [afterRelease] = await listClaims(scope, released.id);
    const [afterExpiry] = await listClaims(scope, timedOut.id);

    expect(afterRelease.outcome).toBe("released");
    expect(afterExpiry.outcome).toBe("expired");
    expect(afterRelease.outcome).not.toBe(afterExpiry.outcome);

    // The words the worker said survive on the release and only on the release.
    expect(afterRelease.note).toMatch(/child is ill/);
    expect(afterExpiry.note).toBeNull();

    // Both put the work back in the pool — the difference is the record, not
    // the consequence for the job.
    expect((await getTask(scope, released.id))!.status).toBe("open");
    expect((await getTask(scope, timedOut.id))!.status).toBe("open");

    // And the audit says who: a release is somebody's decision, an expiry is
    // the clock's and is attributed to nobody.
    const { rows: events } = await owner.query(
      `select task_id, action, actor_id from task_events
        where task_id = any($1::uuid[]) and action like 'claim.%'
        order by id`,
      [[released.id, timedOut.id]],
    );
    const release = events.find((e) => e.action === "claim.released");
    const expiry = events.find((e) => e.action === "claim.expired");
    expect(release.actor_id).toBe(ids.manager);
    expect(expiry.actor_id).toBeNull();
    expect(handedBack!.outcomeAt).toBeInstanceOf(Date);
  });

  test("three attempts on one task leave three distinguishable rows", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Claimed, released, reclaimed",
    });

    const first = await claimTask(scope, { taskId: task.id, userId: ids.worker });
    await releaseClaim(scope, { claimId: first!.id, userId: ids.worker });

    const second = await claimTask(scope, { taskId: task.id, userId: ids.mate });
    await owner.query(
      `update task_claims set claimed_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 hour'
        where id = $1`,
      [second!.id],
    );
    await expireOverdueClaims(scope);

    const third = await claimTask(scope, { taskId: task.id, userId: ids.rival });
    await submitClaim(scope, { claimId: third!.id, userId: ids.rival });

    const claims = await listClaims(scope, task.id);
    expect(claims).toHaveLength(3);
    expect(claims.map((c) => c.outcome).sort()).toEqual([
      "expired",
      "released",
      "submitted",
    ]);
    // A `claimed_by` column on the task would have left exactly one of these.
    expect(new Set(claims.map((c) => c.userId)).size).toBe(3);
  });
});

/* ------------------------------------------------------------------ */

describe("separation of duty, enforced by the database", () => {
  /** A task taken to the point where somebody could approve it. */
  async function submittedWork(title: string, doer = ids.worker) {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title,
    });
    const claim = await claimTask(scope, { taskId: task.id, userId: doer });
    await submitClaim(scope, { claimId: claim!.id, userId: doer });
    return { task, claim: claim! };
  }

  test("the person who did the work may not approve it", async () => {
    const { task, claim } = await submittedWork("Self-approval");
    expect(await refusal(
      gradeTask(scope, {
        taskId: task.id,
        claimId: claim.id,
        graderUserId: ids.worker,
        verdict: "satisfactory",
      }),
    )).toMatch(/separation of duty/);
  });

  test("nor may somebody at the same company", async () => {
    const { task, claim } = await submittedWork("Colleague approval");
    expect(await refusal(
      gradeTask(scope, {
        taskId: task.id,
        claimId: claim.id,
        // `mate` never touched this task. They are simply at the shop.
        graderUserId: ids.mate,
        verdict: "satisfactory",
      }),
    )).toMatch(/same company/);
  });

  test("somebody at a different company may", async () => {
    const { task, claim } = await submittedWork("Proper approval");
    const grade = await gradeTask(scope, {
      taskId: task.id,
      claimId: claim.id,
      graderUserId: ids.approver,
      verdict: "satisfactory",
      score: 90,
      note: "Stitch count is right.",
    });
    expect(grade.verdict).toBe("satisfactory");
    expect(grade.score).toBe(90);
    expect((await getTask(scope, task.id))!.status).toBe("approved");
  });

  test("the rule applies to TAKING ON the approval touch, not only to filing a verdict", async () => {
    const { task } = await submittedWork("Approval touch");
    const approval = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.approveType,
      title: "Approve the digitising",
      approvesTaskId: task.id,
    });

    // The doer cannot pick up the approval touch at all...
    expect(await refusal(
      claimTask(scope, { taskId: approval.id, userId: ids.worker }),
    )).toMatch(/separation of duty/);

    // ...nor can their colleague...
    expect(await refusal(
      claimTask(scope, { taskId: approval.id, userId: ids.mate }),
    )).toMatch(/same company/);

    // ...and the refused claim left nothing behind, so the touch is still open
    // for somebody who may have it.
    expect((await getTask(scope, approval.id))!.status).toBe("open");
    expect(await listClaims(scope, approval.id)).toHaveLength(0);

    const held = await claimTask(scope, {
      taskId: approval.id,
      userId: ids.approver,
    });
    expect(held).not.toBeNull();
  });

  test("an approver may not claim the rework of a task they rejected", async () => {
    const { task, claim } = await submittedWork("Rejected once");

    await gradeTask(scope, {
      taskId: task.id,
      claimId: claim.id,
      graderUserId: ids.approver,
      verdict: "unsatisfactory",
      note: "Stitch density is wrong.",
    });
    expect((await getTask(scope, task.id))!.status).toBe("rejected");

    // The second attempt is a NEW row. Nothing on it names the approver.
    const rework = await openRework(scope, { parentTaskId: task.id });
    expect(rework.parentTaskId).toBe(task.id);
    expect(rework.id).not.toBe(task.id);

    // An approver paid to reject cannot then be paid to do the rework.
    expect(await refusal(
      claimTask(scope, { taskId: rework.id, userId: ids.approver }),
    )).toMatch(/separation of duty/);

    // Nor can their colleague at the studio, which is where the exploit would
    // move to next if the rule were only about the one person.
    const studioMate = (
      await owner.query(
        `insert into users (email, full_name, email_verified_at)
         values ('studiomate@flowtest.test','Studio colleague', now()) returning id`,
      )
    ).rows[0].id;
    await owner.query(
      `insert into memberships (user_id, organization_id, role) values ($1,$2,'member')`,
      [studioMate, ids.studio],
    );
    expect(await refusal(
      claimTask(scope, { taskId: rework.id, userId: studioMate }),
    )).toMatch(/same company/);

    // Somebody with no part in the judgement still can, so the rule refuses
    // the right people rather than everybody.
    const redo = await claimTask(scope, {
      taskId: rework.id,
      userId: ids.rival,
    });
    expect(redo).not.toBeNull();
  });

  test("it refuses an approver who only TOOK ON the review and never filed a verdict", async () => {
    const { task } = await submittedWork("Taken on but never judged");
    const approval = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.approveType,
      title: "Review",
      approvesTaskId: task.id,
    });
    await claimTask(scope, { taskId: approval.id, userId: ids.approver });

    // No grade exists. The link is the claim on the approval touch, and
    // "was SET TO approve" is what the README says the rule must cover.
    const rework = await openRework(scope, { parentTaskId: task.id });
    expect(await refusal(
      claimTask(scope, { taskId: rework.id, userId: ids.approver }),
    )).toMatch(/separation of duty/);
  });

  test("it cannot be walked around by writing to the table directly", async () => {
    // The whole reason this is a trigger. This connection is the OWNER — it
    // bypasses row-level security entirely, and an application-layer check
    // would not exist on this path at all.
    const { task, claim } = await submittedWork("Straight to the table");
    expect(await refusal(
      owner.query(
        `insert into task_grades (organization_id, task_id, claim_id, grader_user_id, verdict)
         values ($1,$2,$3,$4,'satisfactory')`,
        [ids.client, task.id, claim.id, ids.worker],
      ),
    )).toMatch(/separation of duty/);
  });
});

/* ------------------------------------------------------------------ */

describe("qualifications are permissions with a level", () => {
  test("a level per task type, not a flag", async () => {
    await qualify({
      organizationId: ids.client,
      userId: ids.worker,
      taskTypeId: ids.digitize,
      level: "training",
      grantedBy: ids.manager,
    });
    await qualify({
      organizationId: ids.client,
      userId: ids.worker,
      taskTypeId: ids.approveType,
      level: "trainer",
      grantedBy: ids.manager,
    });

    // In training at one kind of work and a trainer at another, at once.
    expect(
      await qualificationLevel(ids.client, ids.worker, ids.digitize),
    ).toBe(QUALIFICATION_LEVELS.training);
    expect(
      await qualificationLevel(ids.client, ids.worker, ids.approveType),
    ).toBe(QUALIFICATION_LEVELS.trainer);

    // It is stored on permissions, not in a table beside it.
    const { rows } = await owner.query(
      `select capability, scope_type, level from permissions
        where organization_id = $1 and user_id = $2 and scope_id = $3
          and revoked_at is null`,
      [ids.client, ids.worker, ids.digitize],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].capability).toBe("task.perform");
    expect(rows[0].scope_type).toBe("task_type");
    expect(rows[0].level).toBe(1);
  });

  test("promotion retires the old grant rather than rewriting it", async () => {
    await qualify({
      organizationId: ids.client,
      userId: ids.mate,
      taskTypeId: ids.digitize,
      level: "training",
      grantedBy: ids.manager,
    });
    await qualify({
      organizationId: ids.client,
      userId: ids.mate,
      taskTypeId: ids.digitize,
      level: "qualified",
      grantedBy: ids.manager,
    });

    expect(await qualificationLevel(ids.client, ids.mate, ids.digitize)).toBe(2);

    const { rows } = await owner.query(
      `select level, revoked_at from permissions
        where organization_id = $1 and user_id = $2 and scope_id = $3
        order by created_at`,
      [ids.client, ids.mate, ids.digitize],
    );
    // "Was in training, is now qualified" — both rows survive.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
  });

  test("losing one task type leaves the others alone", async () => {
    await disqualify({
      organizationId: ids.client,
      userId: ids.worker,
      taskTypeId: ids.digitize,
      grantedBy: ids.manager,
    });
    expect(await qualificationLevel(ids.client, ids.worker, ids.digitize)).toBe(0);
    expect(
      await qualificationLevel(ids.client, ids.worker, ids.approveType),
    ).toBe(QUALIFICATION_LEVELS.trainer);
  });

  test("an offer to a qualification resolves through that level", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Offered by qualification",
    });
    await offerTask(scope, {
      taskId: task.id,
      to: "qualification",
      taskTypeId: ids.digitize,
      minLevel: QUALIFICATION_LEVELS.qualified,
    });

    // `mate` is qualified at digitising; `rival` holds nothing.
    expect(await isOfferedTo(scope, task.id, ids.mate)).toBe(true);
    expect(await isOfferedTo(scope, task.id, ids.rival)).toBe(false);
  });

  test("an offer to a person and an offer to a department are the same row shape", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Offered two ways",
    });
    await offerTask(scope, { taskId: task.id, to: "user", userId: ids.rival });
    await offerTask(scope, {
      taskId: task.id,
      to: "department",
      departmentId: ids.department,
    });
    await owner.query(
      `insert into department_members (department_id, user_id, organization_id)
       values ($1,$2,$3)`,
      [ids.department, ids.approver, ids.client],
    );

    expect(await isOfferedTo(scope, task.id, ids.rival)).toBe(true);
    expect(await isOfferedTo(scope, task.id, ids.approver)).toBe(true);
    expect(await isOfferedTo(scope, task.id, ids.worker)).toBe(false);

    // An offer may not name two audiences at once.
    expect(await refusal(
      owner.query(
        `insert into task_offers (organization_id, task_id, offeree_type, user_id, department_id, created_by)
         values ($1,$2,'user',$3,$4,$5)`,
        [ids.client, task.id, ids.rival, ids.department, ids.manager],
      ),
    )).toMatch(/task_offers_exactly_one_target/);
  });
});

/* ------------------------------------------------------------------ */

describe("these are tenant tables", () => {
  test("another client's session cannot see this client's work", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Not yours",
    });

    const otherClient: Scope = {
      userId: ids.rival,
      email: "rival@flowtest.test",
      isStaff: false,
      organizationId: ids.shop,
    };
    expect(await getTask(otherClient, task.id)).toBeNull();

    // And an unscoped session sees nothing at all, rather than everything.
    const unscoped: Scope = { ...scope, organizationId: null };
    expect(await getTask(unscoped, task.id)).toBeNull();
  });

  test("a claim row cannot be planted under another client's id", async () => {
    const task = await createTask(scope, {
      jobId: ids.job,
      taskTypeId: ids.digitize,
      title: "Cross-tenant claim",
    });
    expect(await refusal(
      owner.query(
        `insert into task_claims (organization_id, task_id, user_id, expires_at)
         values ($1,$2,$3, now() + interval '15 minutes')`,
        [ids.shop, task.id, ids.worker],
      ),
    )).toMatch(/its task belongs to client/);
  });
});
