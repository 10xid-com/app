import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import {
  addReceipts,
  appendUserMessage,
  createConversation,
  finishRun,
  getConversation,
  listConversations,
  listMessages,
  listRuns,
  startRun,
  updateConversation,
  type WorkspaceOwner,
} from "@/lib/db/workspace";
import { closePool } from "@/lib/db/connection";

/**
 * THE WORKSPACE IS ISOLATED TWICE: by client, and by person.
 *
 * Asserted at both layers, as test/isolation.test.ts does for jobs: through the
 * application's own functions, and underneath them by asking Postgres directly
 * as the restricted role. The second layer is the one that matters — it is
 * what still holds for a query nobody has written yet.
 *
 * The cases:
 *   another client          sees none of it (Northstar cannot read Rotary's)
 *   another staff member    sees none of it (same client, different person)
 *   a forged parent id      cannot attach a row to someone else's conversation
 *   build mode              is refused by the database itself
 *   messages and receipts   cannot be edited after the fact
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const appRole = new Client({ connectionString: process.env.DATABASE_APP_URL });

let rotary = "";
let northstar = "";
let paolo = "";
let colleague = "";

beforeAll(async () => {
  await owner.connect();
  await appRole.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'paolo@brandingcentres.test') as paolo
  `);
  rotary = rows[0].rotary;
  northstar = rows[0].northstar;
  paolo = rows[0].paolo;
  expect(rotary, "seed data missing — run npm run db:seed").toBeTruthy();

  const c = await owner.query(`
    insert into users (email) values ('colleague.workspace@brandingcentres.test')
    on conflict (email) do update set email = excluded.email
    returning id
  `);
  colleague = c.rows[0].id;
});

afterAll(async () => {
  await owner.end();
  await appRole.end();
  await closePool();
});

const as = (organizationId: string, userId: string): WorkspaceOwner => ({ organizationId, userId });

/** Open a transaction as the application role with the given settings. */
async function asApp(org: string, user: string, query: string, params: unknown[] = []) {
  await appRole.query("begin");
  try {
    await appRole.query(
      "select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_staff', 'off', true)",
      [org, user],
    );
    return await appRole.query(query, params);
  } finally {
    await appRole.query("rollback");
  }
}

async function seedConversation(org: string, user: string) {
  const conv = await createConversation(as(org, user), {
    title: "Isolation probe",
    mode: "ask",
    engineMode: "claude-coding",
  });
  const msg = await appendUserMessage(as(org, user), conv.id, "what is in ROT-0001?", null);
  const run = await startRun(as(org, user), {
    conversationId: conv.id,
    userMessageId: msg.id,
    mode: "ask",
    engineMode: "claude-coding",
    provider: "anthropic",
    model: "test-model",
  });
  await addReceipts(as(org, user), run.id, [
    { kind: "job", label: "ROT-0001", ref: "x", sentToProvider: true },
  ]);
  await finishRun(as(org, user), {
    runId: run.id,
    conversationId: conv.id,
    status: "completed",
    answer: "An answer.",
  });
  return { conv, msg, run };
}

describe("through the application", () => {
  test("the owner reads their conversation back, whole", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    expect((await getConversation(as(rotary, paolo), conv.id))?.id).toBe(conv.id);
    const messages = await listMessages(as(rotary, paolo), conv.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const runs = await listRuns(as(rotary, paolo), conv.id);
    expect(runs[0]!.receipts.map((r) => r.label)).toEqual(["ROT-0001"]);
  });

  test("another client cannot see it, by list or by exact id", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    expect(await getConversation(as(northstar, paolo), conv.id)).toBeNull();
    const list = await listConversations(as(northstar, paolo));
    expect(list.map((c) => c.id)).not.toContain(conv.id);
    expect(await listMessages(as(northstar, paolo), conv.id)).toEqual([]);
    expect(await listRuns(as(northstar, paolo), conv.id)).toEqual([]);
  });

  test("another staff member on the same client cannot see it", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    expect(await getConversation(as(rotary, colleague), conv.id)).toBeNull();
    expect(await listMessages(as(rotary, colleague), conv.id)).toEqual([]);
    expect(await updateConversation(as(rotary, colleague), conv.id, { title: "taken" })).toBe(false);
  });

  test("a message cannot be written into someone else's conversation", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    // Same client, wrong person; then wrong client, same person.
    await expect(appendUserMessage(as(rotary, colleague), conv.id, "hi", null)).rejects.toThrow();
    await expect(appendUserMessage(as(northstar, paolo), conv.id, "hi", null)).rejects.toThrow();
  });
});

describe("underneath the application, as the restricted role", () => {
  test("a forgotten user id reads nothing at all", async () => {
    await seedConversation(rotary, paolo);
    const r = await asApp(rotary, "", "select id from conversations");
    expect(r.rows).toEqual([]);
  });

  test("raw queries across client or person return no rows", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    for (const [org, user] of [
      [northstar, paolo],
      [rotary, colleague],
    ]) {
      for (const table of ["conversations", "agent_runs"]) {
        const col = table === "conversations" ? "id" : "conversation_id";
        const r = await asApp(org!, user!, `select 1 from ${table} where ${col} = $1`, [conv.id]);
        expect(r.rows, `${table} visible to ${org}/${user}`).toEqual([]);
      }
      const m = await asApp(org!, user!, "select 1 from conversation_messages where conversation_id = $1", [conv.id]);
      expect(m.rows).toEqual([]);
      const rc = await asApp(org!, user!, "select 1 from agent_run_receipts");
      expect(rc.rows.length).toBe(0);
    }
  });

  test("a row naming another person's conversation is refused by its key", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    // The forger's own org and user satisfy every policy; only the composite
    // key stops this.
    await expect(
      asApp(
        rotary,
        colleague,
        `insert into conversation_messages (id, conversation_id, organization_id, created_by, role, content)
         values (gen_random_uuid(), $1, $2, $3, 'user', 'forged')`,
        [conv.id, rotary, colleague],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  test("build mode is refused by the database", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    await expect(
      asApp(rotary, paolo, "update conversations set mode = 'build' where id = $1", [conv.id]),
    ).rejects.toThrow(/conversations_no_build_yet/);
  });

  test("messages and receipts cannot be edited or deleted", async () => {
    const { conv } = await seedConversation(rotary, paolo);
    await expect(
      asApp(rotary, paolo, "update conversation_messages set content = 'rewritten' where conversation_id = $1", [conv.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(rotary, paolo, "delete from agent_run_receipts"),
    ).rejects.toThrow(/permission denied/);
  });
});
