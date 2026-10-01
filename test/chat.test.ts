import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTO, CHAT_MODEL_IDS, FREE_ROUTER } from "@/lib/ai/models";
import {
  ChatError,
  attemptOrder,
  resetModelHealth,
  restFor,
  startChat,
  textFromEventStream,
} from "@/lib/ai/openrouter";

/**
 * The chat's two jobs that can go wrong without anybody noticing:
 *
 *   1. Reading OpenRouter's event stream — where a JSON line can arrive split
 *      across two network chunks, and an error can arrive inside a 200.
 *   2. Falling over to the other free model when the chosen one is throttled,
 *      and NOT falling over when retrying cannot help (a refused key).
 *   3. Remembering which model is busy, so "auto" starts with the one that
 *      will answer instead of waiting on one that just said no.
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

const delta = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const piece of gen) out += piece;
  return out;
}

describe("reading the event stream", () => {
  test("joins the deltas, skips comments, stops at [DONE]", async () => {
    const text = await collect(
      textFromEventStream(
        streamOf(
          ": OPENROUTER PROCESSING\n\n",
          delta("Hello"),
          delta(", world"),
          "data: [DONE]\n\n",
          delta("never read"),
        ),
      ),
    );
    expect(text).toBe("Hello, world");
  });

  test("a line split across two chunks is still read once, whole", async () => {
    const line = delta("split in half");
    const cut = Math.floor(line.length / 2);
    const text = await collect(
      textFromEventStream(streamOf(line.slice(0, cut), line.slice(cut))),
    );
    expect(text).toBe("split in half");
  });

  test("an error inside a 200 is thrown, not mistaken for a short answer", async () => {
    const gen = textFromEventStream(
      streamOf(
        delta("partial"),
        `data: ${JSON.stringify({ error: { code: 429, message: "rate limited" } })}\n\n`,
      ),
    );
    expect((await gen.next()).value).toBe("partial");
    await expect(gen.next()).rejects.toBeInstanceOf(ChatError);
  });
});

describe("choosing a model", () => {
  const [first, second] = CHAT_MODEL_IDS;

  beforeEach(resetModelHealth);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const busy = () => Response.json({ error: { message: "busy" } }, { status: 429 });
  const answer = (text: string, model?: string) =>
    new Response(
      streamOf(
        `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`,
        "data: [DONE]\n",
      ),
    );

  function stubFetch(answers: Record<string, () => Response>) {
    const asked: string[] = [];
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { model: string };
        asked.push(body.model);
        return answers[body.model]!();
      }),
    );
    return asked;
  }

  test("a throttled model hands over to the other one", async () => {
    const asked = stubFetch({
      [first]: () => Response.json({ error: { message: "busy" } }, { status: 429 }),
      [second]: () => new Response(streamOf(delta("from the second"), "data: [DONE]\n")),
    });

    const chat = await startChat({
      model: first,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(asked).toEqual([first, second]);
    expect(chat.model).toBe(second);
    expect(await collect(chat.text)).toBe("from the second");
  });

  test("an error inside the 200, before any text, also hands over", async () => {
    stubFetch({
      [first]: () =>
        new Response(
          streamOf(`data: ${JSON.stringify({ error: { code: 503, message: "down" } })}\n`),
        ),
      [second]: () => new Response(streamOf(delta("ok"), "data: [DONE]\n")),
    });

    const chat = await startChat({
      model: first,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chat.model).toBe(second);
  });

  test("a refused key stops at once — the other model would be refused too", async () => {
    const asked = stubFetch({
      [first]: () => Response.json({ error: { message: "no" } }, { status: 401 }),
      [second]: () => new Response(streamOf(delta("should not be reached"))),
    });

    await expect(
      startChat({ model: first, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/key was refused/);
    expect(asked).toEqual([first]);
  });

  test("auto remembers a busy model and starts with the one that answered", async () => {
    const asked = stubFetch({ [first]: busy, [second]: () => answer("ok") });

    const one = await startChat({ model: AUTO, messages: [{ role: "user", content: "a" }] });
    expect(one.model).toBe(second);
    expect(asked).toEqual([first, second]);

    // The next message does not wait on the model that just said no.
    asked.length = 0;
    const two = await startChat({ model: AUTO, messages: [{ role: "user", content: "b" }] });
    expect(two.model).toBe(second);
    expect(asked).toEqual([second]);
  });

  test("a model picked by hand is still tried first, even while resting", async () => {
    const asked = stubFetch({ [first]: busy, [second]: () => answer("ok") });
    await startChat({ model: AUTO, messages: [{ role: "user", content: "a" }] });

    asked.length = 0;
    await startChat({ model: first, messages: [{ role: "user", content: "b" }] });
    expect(asked[0]).toBe(first);
  });

  test("with both busy, the free router answers and is named as what it reached", async () => {
    const asked = stubFetch({
      [first]: busy,
      [second]: busy,
      [FREE_ROUTER]: () => answer("from somewhere", "meta-llama/llama-5-8b:free"),
    });

    const chat = await startChat({ model: AUTO, messages: [{ role: "user", content: "a" }] });
    expect(asked).toEqual([first, second, FREE_ROUTER]);
    expect(chat.model).toBe("meta-llama/llama-5-8b:free");
    expect(await collect(chat.text)).toBe("from somewhere");
  });

  test("with everything busy, one plain sentence rather than the last refusal", async () => {
    stubFetch({ [first]: busy, [second]: busy, [FREE_ROUTER]: busy });
    await expect(
      startChat({ model: AUTO, messages: [{ role: "user", content: "a" }] }),
    ).rejects.toThrow(/Every free model is busy/);
  });

  test("only free models are ever named", () => {
    // The guarantee .env.example makes: this key cannot spend credit.
    for (const id of attemptOrder(AUTO)) {
      expect(id === FREE_ROUTER || id.endsWith(":free"), id).toBe(true);
    }
  });
});

describe("how long a busy model rests", () => {
  const headers = (h: Record<string, string>) => ({ headers: new Headers(h) });
  const now = 1_000_000_000_000;

  test("Retry-After, in seconds, is honoured", () => {
    expect(restFor(headers({ "retry-after": "30" }), now)).toBe(30_000);
  });

  test("X-RateLimit-Reset, an epoch in milliseconds, is honoured", () => {
    expect(restFor(headers({ "x-ratelimit-reset": String(now + 45_000) }), now)).toBe(45_000);
  });

  test("no hint means a minute", () => {
    expect(restFor(null, now)).toBe(60_000);
  });

  test("a spent daily allowance is still rechecked within ten minutes", () => {
    expect(restFor(headers({ "retry-after": "86400" }), now)).toBe(600_000);
  });
});
