import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { Client } from "pg";
import { runTurn } from "@/lib/workspace/runner";
import type { WorkspaceAccess } from "@/lib/workspace/access";
import type { WireEvent } from "@/lib/workspace/wire";
import { createConversation, listMessages, listRuns } from "@/lib/db/workspace";
import { closePool } from "@/lib/db/connection";

/**
 * A grounded answer, end to end: a real database, the real tools and the real
 * Claude SDK — only the network to Anthropic is replaced.
 *
 * What it proves:
 *   - the answer's sources are rows (receipts), not words in the text;
 *   - a Rotary workspace asking for a Northstar job gets "no such job" — the
 *     tool reads through the workspace's scope, and the model cannot widen it;
 *   - a provider failure is recorded as a failed run with its reason, and the
 *     person's message is kept.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
let rotary = "";
let paolo = "";
let rotaryRef = "";
let northstarRef = "";

beforeAll(async () => {
  await owner.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary') as rotary,
      (select id from users where email = 'paolo@brandingcentres.test') as paolo,
      (select ref from jobs j join organizations o on o.id = j.organization_id where o.slug = 'rotary' order by ref limit 1) as rotary_ref,
      (select ref from jobs j join organizations o on o.id = j.organization_id where o.slug = 'northstar' order by ref limit 1) as northstar_ref
  `);
  ({ rotary, paolo } = rows[0]);
  rotaryRef = rows[0].rotary_ref;
  northstarRef = rows[0].northstar_ref;
  expect(rotaryRef, "seed data missing — run npm run db:seed").toBeTruthy();
});

afterAll(async () => {
  await owner.end();
  await closePool();
});

afterEach(() => vi.unstubAllEnvs());

const access = (): WorkspaceAccess => ({
  owner: { organizationId: rotary, userId: paolo },
  scope: { userId: paolo, email: "paolo@brandingcentres.test", isStaff: true, organizationId: rotary },
  client: { id: rotary, name: "Rotary", isHouse: false },
});

type SseEvent = { event: string; data: unknown };
const sse = (events: SseEvent[]) =>
  new Response(events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

function claude(block: { text: string } | { tool: string; input: unknown }, stop: string): Response {
  const start = { event: "message_start", data: { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } } };
  const body: SseEvent[] =
    "text" in block
      ? [
          { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        ]
      : [
          { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: block.tool, input: {} } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        ];
  return sse([
    start,
    ...body,
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

function scripted(responses: Array<() => Response>): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  let i = 0;
  return {
    bodies,
    fetch: (async (_input: unknown, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return responses[i++]!();
    }) as typeof fetch,
  };
}

async function drain(gen: AsyncIterable<WireEvent>) {
  const out: WireEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("a grounded Ask turn", () => {
  test("reads the job through the tool and records it as the answer's source", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const conv = await createConversation(access().owner, { title: "New conversation", mode: "ask", engineMode: "claude-coding" });
    const net = scripted([
      () => claude({ tool: "read_job", input: { ref: rotaryRef } }, "tool_use"),
      () => claude({ text: `It is in progress [JOB ${rotaryRef}].` }, "end_turn"),
    ]);

    const events = await drain(
      runTurn({ access: access(), conversationId: conv.id, content: `What is happening with ${rotaryRef}?`, command: null, fetch: net.fetch }),
    );

    expect(events[0]).toMatchObject({ type: "run", provider: "anthropic", model: "claude-opus-5-5", mode: "ask" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });

    // The tool result that went back to the model contains the real job.
    const second = net.bodies[1] as { messages: { content: unknown }[] };
    expect(JSON.stringify(second.messages.at(-1))).toContain(rotaryRef);

    // The record: two messages, one completed run, and its sources as rows.
    const messages = await listMessages(access().owner, conv.id);
    expect(messages.map((m) => [m.role, m.status])).toEqual([["user", "complete"], ["assistant", "complete"]]);
    const [run] = await listRuns(access().owner, conv.id);
    expect(run!.status).toBe("completed");
    expect(run!.receipts.map((r) => r.kind)).toEqual(["tool_call", "job"]);
    expect(run!.receipts.find((r) => r.kind === "job")!.label).toContain(rotaryRef);
  });

  test("another client's job is not there to be read, whatever the model asks for", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const conv = await createConversation(access().owner, { title: "Probe", mode: "ask", engineMode: "claude-coding" });
    const net = scripted([
      () => claude({ tool: "read_job", input: { ref: northstarRef } }, "tool_use"),
      () => claude({ text: "I could not find it." }, "end_turn"),
    ]);

    await drain(runTurn({ access: access(), conversationId: conv.id, content: "x", command: null, fetch: net.fetch }));

    const sent = JSON.stringify((net.bodies[1] as { messages: unknown[] }).messages.at(-1));
    expect(sent).toContain("No job");
    expect(sent).not.toContain("Northstar");
    const [run] = await listRuns(access().owner, conv.id);
    expect(run!.receipts.some((r) => r.kind === "job")).toBe(false);
  });

  test("a provider failure is a failed run with its reason, and the question is kept", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "bad");
    const conv = await createConversation(access().owner, { title: "Probe", mode: "plan", engineMode: "claude-coding" });
    const net = scripted([
      () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid" } }, { status: 401 }),
    ]);

    const events = await drain(runTurn({ access: access(), conversationId: conv.id, content: "plan it", command: null, fetch: net.fetch }));

    expect(events.at(-1)).toMatchObject({ type: "done", status: "failed" });
    const [run] = await listRuns(access().owner, conv.id);
    expect(run!.error).toMatch(/ANTHROPIC_API_KEY/);
    expect((await listMessages(access().owner, conv.id)).map((m) => m.role)).toEqual(["user"]);
  });

  test("an engine the client may not use is refused before anything is written", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const conv = await createConversation(access().owner, { title: "Probe", mode: "ask", engineMode: "claude-coding" });
    const events = await drain(runTurn({ access: access(), conversationId: conv.id, content: "x", command: null }));
    expect(events).toEqual([{ type: "error", message: expect.stringMatching(/not available/) }]);
    expect(await listMessages(access().owner, conv.id)).toEqual([]);
  });

  test("/plan switches the conversation to Plan, and the command is recorded", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const conv = await createConversation(access().owner, { title: "Probe", mode: "ask", engineMode: "claude-coding" });
    const net = scripted([() => claude({ text: "1. Do the thing." }, "end_turn")]);
    const events = await drain(runTurn({ access: access(), conversationId: conv.id, content: "add a banner", command: "plan", fetch: net.fetch }));
    expect(events[0]).toMatchObject({ type: "run", mode: "plan", command: "plan" });
    expect((net.bodies[0] as { system: string }).system).toContain("MODE: PLAN");
    const [msg] = await listMessages(access().owner, conv.id);
    expect(msg!.command).toBe("plan");
  });
});
