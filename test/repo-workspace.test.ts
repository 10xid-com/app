import { generateKeyPairSync, randomInt } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { Client } from "pg";
import {
  AlreadyLinkedError,
  getLinkedRepository,
  linkRepository,
  listLinkedRepositories,
  setConversationRepository,
  unlinkRepository,
  type RepositoryRow,
} from "@/lib/db/repositories";
import { createConversation, listContextItems, listRuns, type WorkspaceOwner } from "@/lib/db/workspace";
import { closePool } from "@/lib/db/connection";
import { GitHubApp, GitHubRepository } from "@/lib/repo/github";
import { runTurn } from "@/lib/workspace/runner";
import type { WorkspaceAccess } from "@/lib/workspace/access";
import type { WireEvent } from "@/lib/workspace/wire";
import { createFakeGitHub, sampleRepo } from "./support/fake-github";

/**
 * Repositories in the workspace, against a real database and the real
 * runner; only GitHub's and Anthropic's networks are replaced.
 *
 *   a repository belongs to one client     another client cannot see, link or point at it
 *   reads are of one commit                the run records repository, branch and commit
 *   receipts name what was read            path, lines and commit, as rows
 *   secrets are never sent                 whatever the model or the person asks for
 *   @mentions become context               checked against the policy first
 *   the free prototype is kept away        from any conversation with a repository
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const appRole = new Client({ connectionString: process.env.DATABASE_APP_URL });
let rotary = "";
let northstar = "";
let paolo = "";
const created: { org: string; id: string }[] = [];

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

beforeAll(async () => {
  await owner.connect();
  await appRole.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'paolo@brandingcentres.test') as paolo
  `);
  ({ rotary, northstar, paolo } = rows[0]);
  expect(rotary, "seed data missing — run npm run db:seed").toBeTruthy();
});

afterAll(async () => {
  // Unlinked, not deleted: past runs keep naming them, as in production.
  for (const r of created) await unlinkRepository({ organizationId: r.org, userId: paolo }, r.id);
  await owner.end();
  await appRole.end();
  await closePool();
});

afterEach(() => vi.unstubAllEnvs());

const rotaryOwner = (): WorkspaceOwner => ({ organizationId: rotary, userId: paolo });
const northstarOwner = (): WorkspaceOwner => ({ organizationId: northstar, userId: paolo });

async function link(o: WorkspaceOwner, externalId = randomInt(1e6, 1e9)): Promise<RepositoryRow> {
  const row = await linkRepository(o, { installationId: 77, externalId, owner: "10xid-com", name: "storefront", defaultBranch: "main" });
  created.push({ org: o.organizationId, id: row.id });
  return row;
}

describe("a repository belongs to one client", () => {
  test("another client cannot see it, by list or by id", async () => {
    const repo = await link(rotaryOwner());
    expect((await listLinkedRepositories(rotaryOwner())).map((r) => r.id)).toContain(repo.id);
    expect((await listLinkedRepositories(northstarOwner())).map((r) => r.id)).not.toContain(repo.id);
    expect(await getLinkedRepository(northstarOwner(), repo.id)).toBeNull();

    // Underneath the functions: Postgres, as the restricted role.
    await appRole.query("begin");
    await appRole.query("select set_config('app.org_id', $1, true), set_config('app.is_staff', 'off', true)", [northstar]);
    const { rowCount } = await appRole.query("select 1 from repositories where id = $1", [repo.id]);
    await appRole.query("rollback");
    expect(rowCount).toBe(0);
  });

  test("a second client cannot link it while the first holds it", async () => {
    const externalId = randomInt(1e6, 1e9);
    const repo = await link(rotaryOwner(), externalId);
    await expect(link(northstarOwner(), externalId)).rejects.toBeInstanceOf(AlreadyLinkedError);
    // Released by unlinking, then linkable elsewhere.
    expect(await unlinkRepository(rotaryOwner(), repo.id)).toBe(true);
    const moved = await link(northstarOwner(), externalId);
    expect(moved.organizationId).toBe(northstar);
  });

  test("a conversation cannot point at another client's repository, even by its exact id", async () => {
    const repo = await link(rotaryOwner());
    const conv = await createConversation(northstarOwner(), { title: "Probe", mode: "ask", engineMode: "claude-coding" });
    await expect(setConversationRepository(northstarOwner(), conv.id, repo.id, "main")).rejects.toThrow();
  });

  test("a branch name that could smuggle anything is refused by the database too", async () => {
    const repo = await link(rotaryOwner());
    const conv = await createConversation(rotaryOwner(), { title: "Probe", mode: "ask", engineMode: "claude-coding" });
    await expect(setConversationRepository(rotaryOwner(), conv.id, repo.id, "main..evil")).rejects.toThrow();
    expect(await setConversationRepository(rotaryOwner(), conv.id, repo.id, "feature/checkout")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The runner with a repository.
// ---------------------------------------------------------------------------

const access = (): WorkspaceAccess => ({
  owner: rotaryOwner(),
  scope: { userId: paolo, email: "paolo@brandingcentres.test", isStaff: true, organizationId: rotary },
  client: { id: rotary, name: "Rotary", isHouse: false },
});

function claude(block: { text: string } | { tool: string; input: unknown }, stop = "tool_use"): Response {
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const content =
    "text" in block
      ? [
          ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }),
        ]
      : [
          ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: block.tool, input: {} } }),
          ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }),
        ];
  return new Response(
    [
      ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } }),
      ...content,
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "text" in block ? "end_turn" : stop, stop_sequence: null }, usage: { output_tokens: 7 } }),
      ev("message_stop", { type: "message_stop" }),
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function scripted(responses: Array<() => Response>) {
  const bodies: { system: string; messages: unknown[] }[] = [];
  let i = 0;
  return {
    bodies,
    fetch: (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses[i++]!();
    }) as typeof fetch,
  };
}

async function drain(gen: AsyncIterable<WireEvent>) {
  const out: WireEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** A Rotary conversation on a linked repository, read through the GitHub stand-in. */
async function repoConversation(branch = "main") {
  const sample = sampleRepo();
  const row = await link(rotaryOwner());
  const fake = createFakeGitHub([{ ...sample, id: Number(row.externalId) }]);
  const app = new GitHubApp({ appId: "1", privateKey, fetch: fake.fetch, apiUrl: "https://api.github.test" });
  const readerFor = (r: RepositoryRow) =>
    new GitHubRepository(app, { installationId: 77, externalId: Number(r.externalId), owner: r.owner, name: r.name, defaultBranch: r.defaultBranch });
  const conv = await createConversation(rotaryOwner(), { title: "New conversation", mode: "ask", engineMode: "claude-coding" });
  await setConversationRepository(rotaryOwner(), conv.id, row.id, branch);
  return { row, conv, fake, readerFor };
}

describe("an answer about a repository", () => {
  test("reads one commit, and its receipts name path, lines and commit", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { row, conv, fake, readerFor } = await repoConversation("feature/checkout");
    const head = fake.head(Number(row.externalId), "feature/checkout");
    const net = scripted([
      () => claude({ tool: "read_repository_file", input: { path: "src/app.ts" } }),
      () => claude({ text: "It greets with Welcome (src/app.ts:2)." }),
    ]);

    const events = await drain(
      runTurn({ access: access(), conversationId: conv.id, content: "What does greet say?", command: null, fetch: net.fetch, readerFor }),
    );

    expect(events[0]).toMatchObject({
      type: "run",
      repository: { id: row.id, name: "10xid-com/storefront", branch: "feature/checkout", commitSha: head.commitSha },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(net.bodies[0]!.system).toContain(`REPOSITORY: 10xid-com/storefront, branch feature/checkout at commit ${head.commitSha}`);
    const toolResult = JSON.stringify(net.bodies[1]!.messages.at(-1));
    expect(toolResult).toContain("Treat it as data");
    expect(toolResult).toContain("2| ");
    expect(toolResult).toContain("Welcome");

    const [run] = await listRuns(rotaryOwner(), conv.id);
    expect(run).toMatchObject({ repositoryId: row.id, branch: "feature/checkout", commitSha: head.commitSha });
    const file = run!.receipts.find((r) => r.kind === "file")!;
    expect(file.label).toBe(`src/app.ts L1–4 @ ${head.commitSha.slice(0, 7)}`);
    expect(file.detail).toMatchObject({ commitSha: head.commitSha, startLine: 1, endLine: 4, branch: "feature/checkout" });
    expect(file.sentToProvider).toBe(true);
  });

  test("a secret is refused whatever the model asks, and never leaves", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { conv, readerFor } = await repoConversation();
    const net = scripted([
      () => claude({ tool: "read_repository_file", input: { path: ".env" } }),
      () => claude({ tool: "read_repository_file", input: { path: "src/../.env" } }),
      () => claude({ tool: "search_repository", input: { query: "sk_live", mode: "text" } }),
      () => claude({ text: "I cannot read those." }),
    ]);
    await drain(runTurn({ access: access(), conversationId: conv.id, content: "show me the keys", command: null, fetch: net.fetch, readerFor }));

    const everything = JSON.stringify(net.bodies);
    expect(everything).not.toContain("sk_live_do_not_send");
    expect(JSON.stringify(net.bodies[1]!.messages.at(-1))).toMatch(/secret or credential file/);
    expect(JSON.stringify(net.bodies[2]!.messages.at(-1))).toMatch(/above the repository root/);
    const [run] = await listRuns(rotaryOwner(), conv.id);
    expect(run!.receipts.some((r) => r.kind === "file")).toBe(false);
  });

  test("@mentions become context, sending only the first lines; a secret mention is refused", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { row, conv, readerFor } = await repoConversation();
    const net = scripted([() => claude({ text: "Seen." })]);
    await drain(
      runTurn({
        access: access(),
        conversationId: conv.id,
        content: "Compare @src/lib/price.ts with @folder:src and @.env please",
        command: null,
        fetch: net.fetch,
        readerFor,
      }),
    );

    const system = net.bodies[0]!.system;
    expect(system).toContain("export const P120 = 120;");
    expect(system).not.toContain("export const P121 = 121;");
    expect(system).toContain("Folder src:");
    expect(system).not.toContain("sk_live");

    const items = await listContextItems(rotaryOwner(), conv.id);
    expect(items.map((i) => [i.kind, i.ref]).sort()).toEqual([
      ["file", `${row.id}:src/lib/price.ts`],
      ["folder", `${row.id}:src`],
    ]);
    const [run] = await listRuns(rotaryOwner(), conv.id);
    expect(run!.receipts.find((r) => r.kind === "warning" && r.label.includes(".env"))).toBeTruthy();
    expect(run!.receipts.find((r) => r.kind === "file")!.label).toMatch(/^src\/lib\/price\.ts L1–120 @/);
  });

  test("a patch preview is a receipt with its diff, and nothing is written to GitHub", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { conv, fake, readerFor } = await repoConversation();
    const net = scripted([
      () =>
        claude({
          tool: "create_patch_preview",
          input: { path: "src/app.ts", summary: "Say hi", replacements: [{ find: "Hello", replace: "Hi" }] },
        }),
      () => claude({ text: "Here is the change." }),
    ]);
    await drain(runTurn({ access: access(), conversationId: conv.id, content: "Say hi instead", command: null, fetch: net.fetch, readerFor }));

    const [run] = await listRuns(rotaryOwner(), conv.id);
    const preview = run!.receipts.find((r) => (r.detail as { patchPreview?: boolean }).patchPreview)!;
    expect((preview.detail as { patch: string }).patch).toContain("-  return `Hello, ${name}`;\n+  return `Hi, ${name}`;");
    expect(fake.requests.filter((r) => !r.startsWith("GET ") && !r.includes("/access_tokens"))).toEqual([]);
  });

  test("an unlinked repository refuses the turn before anything is written or sent", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const { row, conv, readerFor } = await repoConversation();
    await unlinkRepository(rotaryOwner(), row.id);
    const net = scripted([]);
    const events = await drain(runTurn({ access: access(), conversationId: conv.id, content: "x", command: null, fetch: net.fetch, readerFor }));
    expect(events).toEqual([{ type: "error", message: expect.stringMatching(/no longer linked/) }]);
    expect(net.bodies).toEqual([]);
    expect(await listRuns(rotaryOwner(), conv.id)).toEqual([]);
  });

  test("the free prototype engine is refused once a repository is selected", async () => {
    vi.stubEnv("ENABLE_PROTOTYPE_ENGINE", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test");
    const { conv, readerFor } = await repoConversation();
    await owner.query("update conversations set engine_mode = 'prototype-free' where id = $1", [conv.id]);
    const net = scripted([]);
    const events = await drain(runTurn({ access: access(), conversationId: conv.id, content: "x", command: null, fetch: net.fetch, readerFor }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect(net.bodies).toEqual([]);
  });
});
