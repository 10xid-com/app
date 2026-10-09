import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import {
  addJobNote,
  getJob,
  handOverJob,
  listJobEvents,
  listJobNotes,
  listJobs,
  type Scope,
} from "@/lib/db";
import { closePool } from "@/lib/db/connection";

/**
 * Passing work around a business: notes on a job, and handing a job over.
 *
 * Through the shared helper, as the application calls it, against login's
 * seed. A second Rotary person is added for the handover and removed after,
 * with everything written about them.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });

let rotaryId = "";
let janeId = "";
let samId = "";
let rotaryJobId = "";
let northstarJobId = "";
const mariaId = randomUUID();

const jane = (): Scope => ({ userId: janeId, email: "jane@rotary.test", isStaff: false, organizationId: rotaryId });
const maria = (): Scope => ({ userId: mariaId, email: "maria@rotary.test", isStaff: false, organizationId: rotaryId });

beforeAll(async () => {
  await owner.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')     as rotary,
      (select id from users where email = 'jane@rotary.test')   as jane,
      (select id from users where email = 'sam@northstar.test') as sam,
      (select id from jobs where ref = 'ROT-0001')             as rotary_job,
      (select id from jobs where ref = 'NOR-0001')             as northstar_job
  `);
  ({ rotary: rotaryId, jane: janeId, sam: samId } = rows[0]);
  rotaryJobId = rows[0].rotary_job;
  northstarJobId = rows[0].northstar_job;
  expect(rotaryJobId, "seed data missing — run login's db:seed").toBeTruthy();

  await owner.query(`insert into users (id, email, full_name) values ($1, 'maria@rotary.test', 'Maria Lopez')`, [mariaId]);
  await owner.query(`insert into memberships (user_id, organization_id, role) values ($1, $2, 'editor')`, [mariaId, rotaryId]);
});

afterAll(async () => {
  await owner.query("update jobs set assigned_to = null where assigned_to = $1", [mariaId]);
  await owner.query("delete from job_notes where author_id = $1 or handed_to = $1 or job_id = $2", [mariaId, rotaryJobId]);
  await owner.query("delete from job_events where actor_id = $1", [mariaId]);
  await owner.query("delete from memberships where user_id = $1", [mariaId]);
  await owner.query("delete from user_emails where user_id = $1", [mariaId]);
  await owner.query("delete from users where id = $1", [mariaId]);
  await owner.end();
  await closePool();
});

describe("handing a job to a teammate", () => {
  test("hands it over with a note, records it, and it is on their list", async () => {
    const before = await getJob(jane(), rotaryJobId);
    const handed = await handOverJob(jane(), rotaryJobId, {
      to: mariaId,
      from: before!.assignedTo,
      note: "  Client wants navy thread.  ",
    });

    expect(handed?.job.assignedTo).toBe(mariaId);
    expect(handed?.note).toMatchObject({ body: "Client wants navy thread.", handedTo: mariaId, authorId: janeId });

    const events = await listJobEvents(jane(), rotaryJobId);
    expect(events[0]).toMatchObject({ action: "handed_over", after: { assignedTo: mariaId } });

    const hers = await listJobs(maria(), { assignedTo: mariaId });
    expect(hers.map((j) => j.id)).toContain(rotaryJobId);
    expect(hers.every((j) => j.assignedTo === mariaId)).toBe(true);
  });

  test("a handover against somebody who no longer has the job is not applied", async () => {
    // Jane looked when nobody had it; Maria has it now.
    expect(await handOverJob(jane(), rotaryJobId, { to: janeId, from: null })).toBeNull();
    expect((await getJob(jane(), rotaryJobId))?.assignedTo).toBe(mariaId);
  });

  test("the person it is with replies, and the whole business reads the thread", async () => {
    await addJobNote(maria(), rotaryJobId, "Got it, done by 3pm.");
    const notes = await listJobNotes(jane(), rotaryJobId);
    expect(notes.map((n) => n.body)).toEqual(["Client wants navy thread.", "Got it, done by 3pm."]);
  });

  test("taking it off them is recorded too", async () => {
    const handed = await handOverJob(jane(), rotaryJobId, { to: null, from: mariaId });
    expect(handed?.job.assignedTo).toBeNull();
    expect(handed?.note).toBeNull();
    expect((await listJobEvents(jane(), rotaryJobId))[0].action).toBe("unassigned");
  });

  test("a job cannot be handed to somebody of another business", async () => {
    await expect(handOverJob(jane(), rotaryJobId, { to: samId, from: null })).rejects.toThrow();
    expect((await getJob(jane(), rotaryJobId))?.assignedTo).toBeNull();
  });
});

describe("another business's job", () => {
  test("cannot be noted on or handed over, and answers as if it did not exist", async () => {
    expect(await addJobNote(jane(), northstarJobId, "smuggled")).toBeNull();
    expect(await handOverJob(jane(), northstarJobId, { to: janeId, from: null })).toBeNull();
    expect(await listJobNotes(jane(), northstarJobId)).toEqual([]);
  });
});
