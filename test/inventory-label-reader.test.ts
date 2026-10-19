import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MAX_IMAGES,
  READING_SCHEMA,
  ReadError,
  checkVision,
  fieldsFromReading,
  forgetVisionChecks,
  parseAnswer,
  readingRequest,
} from "@/lib/inventory/label-reader";

/**
 * lib/inventory/label-reader.ts on its own: the request each kind of Ollama
 * server is sent, how strictly an answer is read back, and how a model's
 * ability to see images is established. No database, no store; the server
 * is a stand-in, so what is proved here is OUR side of the conversation —
 * the live Ollama Cloud answer is checked with scripts/check-label-reader.ts.
 */

const OBJECT = { product_name: { value: "Citric Acid Powder", printed: "CITRIC ACID POWDER", confidence: 0.9, photo: 1 } };

describe("the request", () => {
  test("to Ollama Cloud carries the schema in the words, never as `format`; thinking off, temperature 0", () => {
    const body = readingRequest("gemma4:31b", ["aW1n"], { selfHosted: false });
    expect("format" in body).toBe(false);
    expect(body).toMatchObject({ model: "gemma4:31b", stream: false, think: false, options: { temperature: 0 } });
    expect(body.messages[1].content).toContain(JSON.stringify(READING_SCHEMA));
    expect(body.messages[1].images).toEqual(["aW1n"]);
  });

  test("to a server of our own also carries it as `format`", () => {
    expect(readingRequest("qwen2.5vl:7b", [], { selfHosted: true })).toMatchObject({ format: READING_SCHEMA });
  });
});

describe("the answer", () => {
  test("is the whole reply as a JSON object, or the whole reply in one ```json fence", () => {
    expect(parseAnswer(JSON.stringify(OBJECT))).toEqual(OBJECT);
    expect(parseAnswer("  " + JSON.stringify(OBJECT) + "\n")).toEqual(OBJECT);
    expect(parseAnswer("```json\n" + JSON.stringify(OBJECT, null, 2) + "\n```")).toEqual(OBJECT);
    expect(parseAnswer("```\n" + JSON.stringify(OBJECT) + "\n```")).toEqual(OBJECT);
    expect(parseAnswer("\n```JSON\r\n" + JSON.stringify(OBJECT) + "\r\n```\n")).toEqual(OBJECT);
  });

  test("is nothing dug out of prose, a second fence, an array, or a reply too long to be a label", () => {
    const refused = [
      "Sure! " + JSON.stringify(OBJECT),
      "Here it is:\n```json\n" + JSON.stringify(OBJECT) + "\n```",
      "```json\n" + JSON.stringify(OBJECT) + "\n```\nHope that helps.",
      "```json\n" + JSON.stringify(OBJECT) + "\n```\n```json\n{}\n```",
      "```json " + JSON.stringify(OBJECT) + "```",
      "[" + JSON.stringify(OBJECT) + "]",
      "null",
      "",
      JSON.stringify({ ...OBJECT, padding: "x".repeat(100_001) }),
    ];
    for (const reply of refused) expect(() => parseAnswer(reply), reply.slice(0, 40)).toThrow(ReadError);
  });

  test("takes a number written as a string only when the string is plainly a number", () => {
    const base = { printed: "250 g", confidence: 0.9, photo: 1 };
    const quantity = (amount: unknown, extra: Record<string, unknown> = {}) =>
      fieldsFromReading({ net_quantity: { amount, unit: "g", ...base, ...extra } }, ["doc-1"])[0]?.value;
    expect(quantity("250")).toEqual({ amount: 250, unit: "g" });
    expect(quantity(" 12.5 ")).toEqual({ amount: 12.5, unit: "g" });
    expect(quantity(250)).toEqual({ amount: 250, unit: "g" });
    for (const loose of ["250 g", "about 250", "250,5", "2.5e2", "-250", "0x10", ""]) expect(quantity(loose), loose).toBeUndefined();
    expect(quantity("250", { confidence: "0.9", photo: "1" })).toEqual({ amount: 250, unit: "g" });
    expect(fieldsFromReading({ net_quantity: { amount: 250, unit: "g", ...base, photo: "1.5" } }, ["doc-1"])).toEqual([]);
    expect(fieldsFromReading({ net_quantity: { amount: 250, unit: "g", ...base, photo: String(MAX_IMAGES + 1) } }, ["doc-1"])).toEqual([]);
  });
});

describe("whether a model can see images", () => {
  afterEach(() => forgetVisionChecks());
  const server = { baseUrl: "https://ollama.example.test", apiKey: "test-key", selfHosted: false };

  function stand(handlers: { show?: () => Response; chat?: (body: { messages: { images?: string[] }[] }) => Response }) {
    const calls: string[] = [];
    const doFetch = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/api/show") return handlers.show ? handlers.show() : new Response("", { status: 404 });
      return handlers.chat!(JSON.parse(String(init.body)));
    }) as unknown as typeof fetch;
    return { calls, doFetch };
  }

  const answer = (content: string) => new Response(JSON.stringify({ message: { content } }));

  test("is what /api/show says, when it says; nothing else is asked", async () => {
    const yes = stand({ show: () => new Response(JSON.stringify({ capabilities: ["completion", "vision"] })) });
    expect(await checkVision(server, "gemma4:31b", yes.doFetch)).toEqual({ ok: true, how: "capabilities" });
    expect(yes.calls).toEqual(["/api/show"]);
    forgetVisionChecks();
    const no = stand({ show: () => new Response(JSON.stringify({ capabilities: ["completion"] })) });
    expect(await checkVision(server, "gpt-oss:120b", no.doFetch)).toEqual({ ok: false, reason: "gpt-oss:120b does not accept images." });
    expect(no.calls).toEqual(["/api/show"]);
  });

  test("otherwise is whether it names the colour of a red square — the only image it is sent", async () => {
    const images: string[][] = [];
    const sees = stand({ chat: (b) => (images.push(b.messages[0].images ?? []), answer("Red")) });
    expect(await checkVision(server, "m:1", sees.doFetch)).toEqual({ ok: true, how: "probe" });
    expect(sees.calls).toEqual(["/api/show", "/api/chat"]);
    expect(images[0]).toHaveLength(1);
    expect(Buffer.from(images[0][0], "base64").subarray(1, 4).toString()).toBe("PNG");

    forgetVisionChecks();
    const blind = stand({ chat: () => answer("I cannot view images.") });
    expect(await checkVision(server, "m:1", blind.doFetch)).toMatchObject({ ok: false });

    forgetVisionChecks();
    const refuses = stand({ chat: () => new Response(JSON.stringify({ error: "model does not support images" }), { status: 400 }) });
    expect(await checkVision(server, "m:1", refuses.doFetch)).toEqual({ ok: false, reason: "m:1 does not accept images." });
  });

  test("is remembered once known, and asked again when the server could not be reached", async () => {
    const known = stand({ show: () => new Response(JSON.stringify({ capabilities: ["vision"] })) });
    await checkVision(server, "m:2", known.doFetch);
    await checkVision(server, "m:2", known.doFetch);
    expect(known.calls).toEqual(["/api/show"]);

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkVision(server, "m:3", down)).toMatchObject({ ok: false });
    expect(await checkVision(server, "m:3", down)).toMatchObject({ ok: false });
    expect(vi.mocked(down)).toHaveBeenCalledTimes(4);
  });
});
