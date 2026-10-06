import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { AnthropicEngine } from "@/lib/ai/engine/anthropic";
import { OllamaEngine } from "@/lib/ai/engine/ollama";
import { OpenAIEngine } from "@/lib/ai/engine/openai";
import { defaultMode, engineFor, modeOptions } from "@/lib/ai/engine/registry";
import type { AgentEvent, AgentTool } from "@/lib/ai/engine/types";
import { resetModelHealth } from "@/lib/ai/ollama";

/**
 * The engines, driven through their REAL SDKs (Ollama has none: plain fetch).
 *
 * The network is replaced, not the SDK: each test hands the SDK a fetch that
 * answers with the provider's own streaming format, so the request the SDK
 * builds and the events it parses are the ones production sees. What is
 * asserted is the contract the workspace relies on — text arrives in order,
 * tool inputs are validated before anything runs, every tool call produces a
 * start and an end, refusals and failures are said in words.
 */

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

function sse(events: { event?: string; data: unknown }[]): Response {
  const text = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeFetch(responses: Array<() => Response>, captured: Captured[]): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const next = responses[i++];
    if (!next) throw new Error("no more fake responses");
    return next();
  }) as typeof fetch;
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

const lookup: AgentTool & { calls: unknown[] } = {
  calls: [],
  name: "read_job",
  description: "Read one job",
  inputSchema: z.toJSONSchema(z.object({ ref: z.string() })) as Record<string, unknown>,
  parse(input) {
    const r = z.object({ ref: z.string().regex(/^[A-Z]{3}-\d{4}$/) }).safeParse(input);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: "ref must look like ROT-0001" };
  },
  async run(input) {
    lookup.calls.push(input);
    return { content: "ROT-0001: Banner reprint, in progress" };
  },
};

/* --------------------------- Anthropic --------------------------- */

type SseEvent = { event?: string; data: unknown };

const claudeMessage = (content: unknown[], stop: string, model = "claude-opus-5-5"): SseEvent[] => [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_1", type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  },
  ...content.flatMap((block, index): SseEvent[] => {
    const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown };
    if (b.type === "text") {
      return [
        { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index } },
      ];
    }
    return [
      { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index } },
    ];
  }),
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];

describe("the Claude engine", () => {
  test("streams text, opts into the refusal fallback, and sets effort", async () => {
    const captured: Captured[] = [];
    const engine = new AnthropicEngine("claude-opus-5-5", {
      apiKey: "test",
      effort: "medium",
      capabilities: ["text", "tool_calling"],
      fetch: fakeFetch([() => sse(claudeMessage([{ type: "text", text: "Hello there" }], "end_turn"))], captured),
    });

    const events = await collect(engine.stream({ system: "Be brief.", history: [{ role: "user", content: "hi" }], tools: [] }));

    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Hello there");
    expect(captured[0]!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(captured[0]!.body).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      system: "Be brief.",
      output_config: { effort: "medium" },
    });
  });

  test("runs a valid tool call, feeds the result back, then answers", async () => {
    lookup.calls = [];
    const captured: Captured[] = [];
    const engine = new AnthropicEngine("claude-opus-5-5", {
      apiKey: "test",
      capabilities: ["text", "tool_calling"],
      fetch: fakeFetch(
        [
          () => sse(claudeMessage([{ type: "tool_use", id: "tu_1", name: "read_job", input: { ref: "ROT-0001" } }], "tool_use")),
          () => sse(claudeMessage([{ type: "text", text: "It is in progress." }], "end_turn")),
        ],
        captured,
      ),
    });

    const events = await collect(engine.stream({ system: "s", history: [{ role: "user", content: "status?" }], tools: [lookup] }));

    expect(lookup.calls).toEqual([{ ref: "ROT-0001" }]);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_end", "text", "usage"]);
    // The second request carries the tool result back, unchanged history first.
    const second = captured[1]!.body.messages as { role: string; content: unknown }[];
    expect(second.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ROT-0001: Banner reprint, in progress" }],
    });
  });

  test("an invalid tool input never reaches the tool", async () => {
    lookup.calls = [];
    const engine = new AnthropicEngine("claude-opus-5-5", {
      apiKey: "test",
      capabilities: ["text", "tool_calling"],
      fetch: fakeFetch(
        [
          () => sse(claudeMessage([{ type: "tool_use", id: "tu_1", name: "read_job", input: { ref: "../../etc/passwd" } }], "tool_use")),
          () => sse(claudeMessage([{ type: "text", text: "Sorry." }], "end_turn")),
        ],
        [],
      ),
    });
    const events = await collect(engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [lookup] }));
    expect(lookup.calls).toEqual([]);
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ ok: false });
  });

  test("a refusal that survives the fallback is said, and a fallback model is named", async () => {
    const engine = new AnthropicEngine("claude-opus-5-5", {
      apiKey: "test",
      capabilities: ["text"],
      fetch: fakeFetch([() => sse(claudeMessage([], "refusal", "claude-opus-4-8"))], []),
    });
    const events = await collect(engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [] }));
    expect(events.find((e) => e.type === "model")).toEqual({ type: "model", model: "claude-opus-4-8" });
    expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "warning" });
  });

  test("a refused key is reported in words, not as a status code", async () => {
    const engine = new AnthropicEngine("claude-opus-5-5", {
      apiKey: "bad",
      capabilities: ["text"],
      fetch: fakeFetch(
        [() => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })],
        [],
      ),
    });
    await expect(collect(engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [] }))).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});

/* ----------------------------- OpenAI ----------------------------- */

const openaiResponse = (output: unknown[], status = "completed") => ({
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "test-model",
  status,
  output,
  usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
});

describe("the OpenAI engine", () => {
  test("streams text and does not store the response by default", async () => {
    const captured: Captured[] = [];
    const engine = new OpenAIEngine("test-model", {
      apiKey: "test",
      store: false,
      capabilities: ["text", "tool_calling"],
      fetch: fakeFetch(
        [
          () =>
            sse([
              { data: { type: "response.output_text.delta", delta: "Hi ", item_id: "m", output_index: 0, content_index: 0, sequence_number: 1 } },
              { data: { type: "response.output_text.delta", delta: "there", item_id: "m", output_index: 0, content_index: 0, sequence_number: 2 } },
              { data: { type: "response.completed", response: openaiResponse([{ type: "message", id: "m", role: "assistant", status: "completed", content: [] }]), sequence_number: 3 } },
            ]),
        ],
        captured,
      ),
    });
    const events = await collect(engine.stream({ system: "Be brief.", history: [{ role: "user", content: "hi" }], tools: [] }));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Hi there");
    expect(captured[0]!.body).toMatchObject({ model: "test-model", instructions: "Be brief.", store: false, stream: true });
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 12, outputTokens: 3 });
  });

  test("runs a function call and sends its output back by call id", async () => {
    lookup.calls = [];
    const captured: Captured[] = [];
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_job", arguments: '{"ref":"ROT-0001"}', status: "completed" };
    const engine = new OpenAIEngine("test-model", {
      apiKey: "test",
      store: false,
      capabilities: ["text", "tool_calling"],
      fetch: fakeFetch(
        [
          () => sse([{ data: { type: "response.completed", response: openaiResponse([call]), sequence_number: 1 } }]),
          () =>
            sse([
              { data: { type: "response.output_text.delta", delta: "In progress.", item_id: "m", output_index: 0, content_index: 0, sequence_number: 1 } },
              { data: { type: "response.completed", response: openaiResponse([]), sequence_number: 2 } },
            ]),
        ],
        captured,
      ),
    });
    const events = await collect(engine.stream({ system: "s", history: [{ role: "user", content: "status?" }], tools: [lookup] }));
    expect(lookup.calls).toEqual([{ ref: "ROT-0001" }]);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_end", "text", "usage"]);
    const input = captured[1]!.body.input as Record<string, unknown>[];
    expect(input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_1", output: "ROT-0001: Banner reprint, in progress" });
  });
});

/* ----------------------------- Ollama ----------------------------- */

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

const ollamaDone = { done: true, done_reason: "stop", prompt_eval_count: 20, eval_count: 4 };

describe("the Ollama engine", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelHealth();
  });

  test("streams text, names the model auto reached, and counts usage", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "k");
    const captured: Captured[] = [];
    const engine = new OllamaEngine("auto", {
      capabilities: ["text", "streaming"],
      fetch: fakeFetch(
        [
          () =>
            ndjson([
              { model: "gpt-oss:120b", message: { role: "assistant", content: "", thinking: "hmm" }, done: false },
              { model: "gpt-oss:120b", message: { role: "assistant", content: "Hi " }, done: false },
              { model: "gpt-oss:120b", message: { role: "assistant", content: "there" }, done: false },
              ollamaDone,
            ]),
        ],
        captured,
      ),
    });
    const events = await collect(engine.stream({ system: "Be brief.", history: [{ role: "user", content: "hi" }], tools: [] }));
    expect(events).toEqual([
      { type: "model", model: "gpt-oss:120b" },
      { type: "text", text: "Hi " },
      { type: "text", text: "there" },
      { type: "usage", inputTokens: 20, outputTokens: 4 },
    ]);
    expect(captured[0]!.body).toMatchObject({
      model: "gpt-oss:120b",
      stream: true,
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }],
    });
    expect(captured[0]!.body).not.toHaveProperty("tools");
  });

  test("self-hosted runs a valid tool call and sends the result back by name", async () => {
    vi.stubEnv("OLLAMA_SELF_HOSTED", "true");
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.internal:11434");
    lookup.calls = [];
    const captured: Captured[] = [];
    const engine = new OllamaEngine("gpt-oss:20b", {
      capabilities: ["text", "tool_calling", "streaming"],
      fetch: fakeFetch(
        [
          () =>
            ndjson([
              {
                message: {
                  role: "assistant",
                  content: "",
                  thinking: "look it up",
                  tool_calls: [{ function: { name: "read_job", arguments: { ref: "ROT-0001" } } }],
                },
                done: false,
              },
              ollamaDone,
            ]),
          () => ndjson([{ message: { role: "assistant", content: "In progress." }, done: false }, ollamaDone]),
        ],
        captured,
      ),
    });
    const events = await collect(engine.stream({ system: "s", history: [{ role: "user", content: "status?" }], tools: [lookup] }));

    expect(lookup.calls).toEqual([{ ref: "ROT-0001" }]);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_end", "text", "usage"]);
    expect(captured[0]!.url).toBe("http://ollama.internal:11434/api/chat");
    expect(captured[0]!.headers.get("authorization")).toBeNull();
    expect(captured[0]!.body.tools).toEqual([
      { type: "function", function: { name: "read_job", description: "Read one job", parameters: lookup.inputSchema } },
    ]);
    // The second request repeats the call, its thinking, then the result.
    const second = captured[1]!.body;
    expect(second.model).toBe("gpt-oss:20b");
    expect((second.messages as unknown[]).slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        thinking: "look it up",
        tool_calls: [{ function: { name: "read_job", arguments: { ref: "ROT-0001" } } }],
      },
      { role: "tool", tool_name: "read_job", content: "ROT-0001: Banner reprint, in progress" },
    ]);
  });

  test("an invalid tool input never reaches the tool", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "k");
    lookup.calls = [];
    const engine = new OllamaEngine("gpt-oss:120b", {
      capabilities: ["text", "tool_calling"],
      fetch: fakeFetch(
        [
          () =>
            ndjson([
              { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_job", arguments: { ref: "../../etc/passwd" } } }] }, done: false },
              ollamaDone,
            ]),
          () => ndjson([{ message: { role: "assistant", content: "Sorry." }, done: false }, ollamaDone]),
        ],
        [],
      ),
    });
    const events = await collect(engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [lookup] }));
    expect(lookup.calls).toEqual([]);
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ ok: false });
  });

  test("the prototype refuses tools before anything is sent", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "k");
    const captured: Captured[] = [];
    const engine = new OllamaEngine("auto", { capabilities: ["text", "streaming"], fetch: fakeFetch([], captured) });
    await expect(collect(engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [lookup] }))).rejects.toThrow(
      /cannot use tools/,
    );
    expect(captured).toEqual([]);
  });

  test("a refused key is reported in words, not as a status code", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "bad");
    const engine = new OllamaEngine("auto", {
      capabilities: ["text"],
      fetch: fakeFetch([() => Response.json({ error: "unauthorized" }, { status: 401 })], []),
    });
    await expect(collect(engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [] }))).rejects.toThrow(
      /OLLAMA_API_KEY/,
    );
  });
});

/* ----------------------------- Routing ----------------------------- */

describe("the routing policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("Claude — Coding is the default when Claude is set up", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.stubEnv("OPENAI_MODEL_REVIEW", "some-model");
    expect(defaultMode(modeOptions(new Set()))).toBe("claude-coding");
  });

  test("an OpenAI mode without a configured model is unavailable, and says why", () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.stubEnv("OPENAI_MODEL_MULTIMODAL", "");
    const opt = modeOptions(new Set()).find((o) => o.id === "openai-multimodal")!;
    expect(opt.available).toBe(false);
    expect(opt.reason).toMatch(/OPENAI_MODEL_MULTIMODAL/);
  });

  test("a client's policy withholds a mode", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    const withheld = new Set(["claude-deep"]);
    expect(modeOptions(withheld).find((o) => o.id === "claude-deep")!.available).toBe(false);
    expect(engineFor("claude-deep", withheld)).toMatchObject({ error: expect.stringMatching(/Not permitted/) });
  });

  test("the prototype is off unless switched on, and refused once there is context", () => {
    vi.stubEnv("OLLAMA_API_KEY", "k");
    expect(modeOptions(new Set()).some((o) => o.id === "prototype-free")).toBe(false);
    vi.stubEnv("ENABLE_PROTOTYPE_ENGINE", "true");
    expect("engine" in engineFor("prototype-free", new Set(), { hasContext: false })).toBe(true);
    expect(engineFor("prototype-free", new Set(), { hasContext: true })).toMatchObject({
      error: expect.stringMatching(/cannot be used/),
    });
  });

  test("the prototype without an Ollama key is listed but unavailable, and says why", () => {
    vi.stubEnv("ENABLE_PROTOTYPE_ENGINE", "true");
    vi.stubEnv("OLLAMA_API_KEY", "");
    const opt = modeOptions(new Set()).find((o) => o.id === "prototype-free")!;
    expect(opt.available).toBe(false);
    expect(opt.reason).toMatch(/OLLAMA_API_KEY/);
  });

  test("self-hosted exists only when said, takes context and tools, and replaces the prototype", () => {
    vi.stubEnv("ENABLE_PROTOTYPE_ENGINE", "true");
    vi.stubEnv("OLLAMA_API_KEY", "k");
    expect(modeOptions(new Set()).some((o) => o.id === "ollama-self-hosted")).toBe(false);
    expect(engineFor("ollama-self-hosted", new Set())).toMatchObject({ error: expect.stringMatching(/OLLAMA_SELF_HOSTED/) });

    vi.stubEnv("OLLAMA_SELF_HOSTED", "true");
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.internal:11434");
    const options = modeOptions(new Set());
    expect(options.map((o) => o.id)).not.toContain("prototype-free");
    expect(options.find((o) => o.id === "ollama-self-hosted")).toMatchObject({ available: true, canUseTools: true });
    expect(defaultMode(options)).toBe("ollama-self-hosted");
    const resolved = engineFor("ollama-self-hosted", new Set(), { hasContext: true });
    expect("engine" in resolved && resolved.engine.supports("tool_calling")).toBe(true);
  });

  test("each Ollama model is its own entry, named with whose model it is", () => {
    vi.stubEnv("ENABLE_PROTOTYPE_ENGINE", "true");
    vi.stubEnv("OLLAMA_API_KEY", "k");
    const ollama = modeOptions(new Set()).filter((o) => o.provider === "ollama");
    expect(ollama.map((o) => [o.id, o.label])).toEqual([
      ["prototype-free", "Ollama — Auto"],
      ["ollama:gpt-oss:120b", "Ollama — gpt-oss 120B (OpenAI)"],
      ["ollama:kimi-k2.7-code", "Ollama — Kimi K2.7 Code (Moonshot AI)"],
      ["ollama:gemma4:31b", "Ollama — Gemma 4 31B (Google)"],
      ["ollama:gpt-oss:20b", "Ollama — gpt-oss 20B (OpenAI)"],
    ]);
    expect(ollama.every((o) => o.available && !o.canUseTools)).toBe(true);
    // A model not on the server's list never runs, whatever a request says.
    expect(engineFor("ollama:some-paid-model", new Set())).toMatchObject({ error: expect.stringMatching(/No longer offered/) });
  });

  test("an Ollama Cloud model entry keeps the prototype's fence, and asks only its own model", async () => {
    vi.stubEnv("ENABLE_PROTOTYPE_ENGINE", "true");
    vi.stubEnv("OLLAMA_API_KEY", "k");
    expect(engineFor("ollama:gemma4:31b", new Set(), { hasContext: true })).toMatchObject({
      error: expect.stringMatching(/cannot be used/),
    });

    const captured: Captured[] = [];
    const resolved = engineFor("ollama:gemma4:31b", new Set(), {
      hasContext: false,
      fetch: fakeFetch([() => Response.json({ error: "busy" }, { status: 429 })], captured),
    });
    if (!("engine" in resolved)) throw new Error(resolved.error);
    expect(resolved.engine.model).toBe("gemma4:31b");
    await expect(collect(resolved.engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [] }))).rejects.toThrow(
      /gemma4:31b is busy/,
    );
    expect(captured.map((c) => c.body.model)).toEqual(["gemma4:31b"]);
  });

  test("self-hosted model entries come from OLLAMA_MODELS and get tools", () => {
    vi.stubEnv("OLLAMA_SELF_HOSTED", "true");
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.internal:11434");
    vi.stubEnv("OLLAMA_MODELS", "qwen3:8b");
    const ollama = modeOptions(new Set()).filter((o) => o.provider === "ollama");
    expect(ollama.map((o) => o.id)).toEqual(["ollama-self-hosted", "ollama:qwen3:8b"]);
    expect(ollama.find((o) => o.id === "ollama:qwen3:8b")).toMatchObject({ label: "Ollama — qwen3:8b", canUseTools: true });
    expect("engine" in engineFor("ollama:qwen3:8b", new Set(), { hasContext: true })).toBe(true);
  });

  test("a model taken off the list stays visible for its conversations, and never runs or can be picked", () => {
    vi.stubEnv("ENABLE_PROTOTYPE_ENGINE", "true");
    vi.stubEnv("OLLAMA_API_KEY", "k");
    vi.stubEnv("OLLAMA_MODELS", "gpt-oss:120b");
    expect(engineFor("ollama:gemma4:31b", new Set())).toMatchObject({ error: expect.stringMatching(/No longer offered/) });
    // The picker for that conversation still shows it, marked unavailable...
    expect(modeOptions(new Set(), "ollama:gemma4:31b").find((o) => o.id === "ollama:gemma4:31b")).toMatchObject({
      label: "Ollama — Gemma 4 31B (Google)",
      available: false,
    });
    // ...but no other picker lists it, so it cannot be chosen.
    expect(modeOptions(new Set()).some((o) => o.id === "ollama:gemma4:31b")).toBe(false);
  });

  test("a model withheld by name is never tried by Auto, and Auto goes when all are withheld", async () => {
    vi.stubEnv("OLLAMA_SELF_HOSTED", "true");
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.internal:11434");
    vi.stubEnv("OLLAMA_MODELS", "qwen3:8b,gemma3:12b");
    const captured: Captured[] = [];
    const resolved = engineFor("ollama-self-hosted", new Set(["ollama:qwen3:8b"]), {
      hasContext: true,
      fetch: fakeFetch([() => Response.json({ error: "busy" }, { status: 429 })], captured),
    });
    if (!("engine" in resolved)) throw new Error(resolved.error);
    await expect(collect(resolved.engine.stream({ system: "s", history: [{ role: "user", content: "x" }], tools: [] }))).rejects.toThrow();
    expect(captured.map((c) => c.body.model)).toEqual(["gemma3:12b"]);

    const allWithheld = new Set(["ollama:qwen3:8b", "ollama:gemma3:12b"]);
    expect(modeOptions(allWithheld).find((o) => o.id === "ollama-self-hosted")!.available).toBe(false);
    expect(engineFor("ollama-self-hosted", allWithheld)).toMatchObject({ error: expect.stringMatching(/Not permitted/) });
  });

  test("withholding an Ollama Auto mode from a client withholds every model under it", () => {
    vi.stubEnv("OLLAMA_SELF_HOSTED", "true");
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.internal:11434");
    vi.stubEnv("OLLAMA_MODELS", "qwen3:8b");
    const withheld = new Set(["ollama-self-hosted"]);
    expect(modeOptions(withheld).find((o) => o.id === "ollama:qwen3:8b")).toMatchObject({
      available: false,
      reason: "Not permitted for this client.",
    });
    expect(engineFor("ollama:qwen3:8b", withheld, { hasContext: true })).toMatchObject({
      error: expect.stringMatching(/Not permitted/),
    });
    // A policy on one model alone still applies to that model.
    expect(modeOptions(new Set(["ollama:qwen3:8b"])).find((o) => o.id === "ollama:qwen3:8b")!.available).toBe(false);
  });

  test("self-hosted pointed at Ollama Cloud is refused", () => {
    vi.stubEnv("OLLAMA_SELF_HOSTED", "true");
    vi.stubEnv("OLLAMA_BASE_URL", "https://ollama.com");
    vi.stubEnv("OLLAMA_API_KEY", "k");
    const opt = modeOptions(new Set()).find((o) => o.id === "ollama-self-hosted")!;
    expect(opt.available).toBe(false);
    expect(opt.reason).toMatch(/your own Ollama server/);
  });
});
