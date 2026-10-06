import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTO,
  ChatError,
  DEFAULT_MODELS,
  attemptOrder,
  chunksFromStream,
  ollamaModels,
  ollamaUnavailability,
  openChat,
  resetModelHealth,
  restFor,
  textOf,
} from "@/lib/ai/ollama";

/**
 * The Ollama client's jobs that can go wrong without anybody noticing:
 *
 *   1. Reading Ollama's stream — where a JSON line can arrive split across two
 *      network chunks, and an error can arrive inside a 200.
 *   2. Falling over to the next model in "auto" when one is throttled or
 *      missing, and NOT falling over when retrying cannot help (a refused key)
 *      or when the person picked one model by name.
 *   3. Remembering which model is busy, so "auto" starts with the one that
 *      will answer instead of waiting on one that just said no.
 *   4. Never calling a server "self-hosted" when it is Ollama's own cloud.
 *
 * No network: fetch is replaced, and every byte the "server" sends is written
 * out below.
 */

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const line = (text: string, model = "m") =>
  `${JSON.stringify({ model, message: { role: "assistant", content: text }, done: false })}\n`;
const done = `${JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 2 })}\n`;

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const piece of gen) out += piece;
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("reading the stream", () => {
  test("joins the content, stops at done", async () => {
    const text = await collect(
      textOf(chunksFromStream(streamOf(line("Hello"), line(", world"), done, line("never read")))),
    );
    expect(text).toBe("Hello, world");
  });

  test("a line split across two chunks is still read once, whole", async () => {
    const l = line("split in half");
    const cut = Math.floor(l.length / 2);
    const text = await collect(textOf(chunksFromStream(streamOf(l.slice(0, cut), l.slice(cut)))));
    expect(text).toBe("split in half");
  });

  test("a last line without its newline is still read", async () => {
    const text = await collect(textOf(chunksFromStream(streamOf(line("end").trimEnd()))));
    expect(text).toBe("end");
  });

  test("an error inside a 200 is thrown, not mistaken for a short answer", async () => {
    const gen = textOf(
      chunksFromStream(streamOf(line("partial"), `${JSON.stringify({ error: "server overloaded" })}\n`)),
    );
    expect((await gen.next()).value).toBe("partial");
    await expect(gen.next()).rejects.toBeInstanceOf(ChatError);
  });
});

describe("configuration", () => {
  test("Ollama Cloud needs a key", () => {
    vi.stubEnv("OLLAMA_API_KEY", "");
    expect(ollamaUnavailability()).toMatch(/OLLAMA_API_KEY/);
    vi.stubEnv("OLLAMA_API_KEY", "k");
    expect(ollamaUnavailability()).toBeNull();
  });

  test("a self-hosted server needs no key", () => {
    vi.stubEnv("OLLAMA_API_KEY", "");
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.railway.internal:11434");
    expect(ollamaUnavailability()).toBeNull();
  });

  test("Ollama's own cloud is never accepted as self-hosted", () => {
    vi.stubEnv("OLLAMA_API_KEY", "k");
    vi.stubEnv("OLLAMA_SELF_HOSTED", "true");
    expect(ollamaUnavailability()).toMatch(/OLLAMA_BASE_URL/);
    vi.stubEnv("OLLAMA_BASE_URL", "https://ollama.com");
    expect(ollamaUnavailability()).toMatch(/OLLAMA_BASE_URL/);
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.railway.internal:11434");
    expect(ollamaUnavailability()).toBeNull();
  });

  test("OLLAMA_MODELS replaces the list; unset, the defaults stand", () => {
    expect(ollamaModels()).toEqual([...DEFAULT_MODELS]);
    vi.stubEnv("OLLAMA_MODELS", " gpt-oss:20b , qwen3:8b ,auto");
    // "auto" is never a model: it would fan out like the Auto entry.
    expect(ollamaModels()).toEqual(["gpt-oss:20b", "qwen3:8b"]);
  });
});

describe("choosing a model", () => {
  const [first, second] = DEFAULT_MODELS;

  beforeEach(resetModelHealth);

  const busy = () => Response.json({ error: "busy" }, { status: 429 });
  const answer = (text: string) => new Response(streamOf(line(text), done));

  function stubFetch(answers: Record<string, () => Response>) {
    const asked: string[] = [];
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubEnv("OLLAMA_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { model: string };
        asked.push(body.model);
        seen.push({ url, auth: new Headers(init.headers).get("authorization") });
        // A model the test did not mention is busy, so a test about two
        // models keeps meaning the same thing however many the list holds.
        return (answers[body.model] ?? busy)();
      }),
    );
    return { asked, seen };
  }

  const ask = (choice: string) =>
    openChat({ models: attemptOrder(choice), messages: [{ role: "user", content: "hi" }] });

  test("goes to Ollama Cloud's chat endpoint with the key", async () => {
    const { seen } = stubFetch({ [first]: () => answer("ok") });
    await ask(AUTO);
    expect(seen[0]).toEqual({ url: "https://ollama.com/api/chat", auth: "Bearer test-key" });
  });

  test("in auto, a throttled model hands over to the next one", async () => {
    const { asked } = stubFetch({ [first]: busy, [second]: () => answer("from the second") });
    const chat = await ask(AUTO);
    expect(asked).toEqual([first, second]);
    expect(chat.model).toBe(second);
    expect(await collect(textOf(chat.chunks))).toBe("from the second");
  });

  test("a model picked by name never hands over, and says it is busy", async () => {
    const { asked } = stubFetch({ [first]: busy, [second]: () => answer("must not be used") });
    await expect(ask(first)).rejects.toThrow(`${first} is busy right now`);
    expect(asked).toEqual([first]);
  });

  test("a model missing from the server hands over too", async () => {
    stubFetch({
      [first]: () => Response.json({ error: `model "${first}" not found` }, { status: 404 }),
      [second]: () => answer("ok"),
    });
    expect((await ask(AUTO)).model).toBe(second);
  });

  test("an error inside the 200, before any text, also hands over", async () => {
    stubFetch({
      [first]: () => new Response(streamOf(`${JSON.stringify({ error: "down" })}\n`)),
      [second]: () => answer("ok"),
    });
    expect((await ask(AUTO)).model).toBe(second);
  });

  test("a refused key stops at once — the other model would be refused too", async () => {
    const { asked } = stubFetch({
      [first]: () => Response.json({ error: "unauthorized" }, { status: 401 }),
      [second]: () => answer("should not be reached"),
    });
    await expect(ask(AUTO)).rejects.toThrow(/refused the key/);
    expect(asked).toEqual([first]);
  });

  test("auto remembers a busy model and starts with the one that answered", async () => {
    const { asked } = stubFetch({ [first]: busy, [second]: () => answer("ok") });

    expect((await ask(AUTO)).model).toBe(second);
    expect(asked).toEqual([first, second]);

    // The next message does not wait on the model that just said no.
    asked.length = 0;
    expect((await ask(AUTO)).model).toBe(second);
    expect(asked).toEqual([second]);
  });

  test("a model picked by name is still tried while resting, and alone", async () => {
    const { asked } = stubFetch({ [first]: busy, [second]: () => answer("ok") });
    await ask(AUTO);
    asked.length = 0;
    await ask(first).catch(() => {});
    expect(asked).toEqual([first]);
  });

  test("with everything busy, one plain sentence rather than the last refusal", async () => {
    stubFetch({});
    await expect(ask(AUTO)).rejects.toThrow(/Every Ollama model is busy/);
  });
});

describe("how long a busy model rests", () => {
  const headers = (h: Record<string, string>) => ({ headers: new Headers(h) });

  test("Retry-After, in seconds, is honoured", () => {
    expect(restFor(headers({ "retry-after": "30" }))).toBe(30_000);
  });

  test("no hint means a minute", () => {
    expect(restFor(null)).toBe(60_000);
  });

  test("a spent allowance is still rechecked within ten minutes", () => {
    expect(restFor(headers({ "retry-after": "86400" }))).toBe(600_000);
  });
});
