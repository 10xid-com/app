import "server-only";

/**
 * The one place the portal talks to Ollama.
 *
 * Ollama Cloud (ollama.com) by default, or any Ollama server named by
 * OLLAMA_BASE_URL — the API is the same either way. Plain fetch against the
 * native /api/chat endpoint, for the same reason the rest of this codebase
 * pins its dependencies exactly: an SDK is a second version number to keep in
 * step, and this is one POST and a stream of JSON lines.
 *
 * Inert without configuration, like the other integrations: the picker says
 * what is missing rather than half-working.
 */

const CLOUD_URL = "https://ollama.com";

/**
 * The models the chat may use, in the order "auto" tries them.
 *
 * Both are on Ollama Cloud (checked against ollama.com/api/tags on
 * 2026-10-06). OLLAMA_MODELS replaces the list — a self-hosted server will not
 * have models this size, so it names its own.
 *
 * Only the server's environment names a model: nothing in a request can, so a
 * caller cannot point the chat at a model nobody chose.
 */
export const DEFAULT_MODELS = ["gpt-oss:120b", "kimi-k2.7-code"] as const;

/** "Use whichever model is answering." The default. */
export const AUTO = "auto";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function ollamaModels(): string[] {
  const listed = env("OLLAMA_MODELS")
    ?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return listed?.length ? listed : [...DEFAULT_MODELS];
}

export type OllamaConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  /**
   * The server runs on infrastructure we control, so client material may be
   * sent to it. Only ever true when someone said so: a forgotten setting keeps
   * client data in, rather than sending it out.
   */
  selfHosted: boolean;
};

export function ollamaConfig(): OllamaConfig {
  return {
    baseUrl: (env("OLLAMA_BASE_URL") ?? CLOUD_URL).replace(/\/+$/, ""),
    apiKey: env("OLLAMA_API_KEY"),
    selfHosted: env("OLLAMA_SELF_HOSTED") === "true",
  };
}

function isCloud(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

/** Why Ollama cannot be used on this server, or null when it can. */
export function ollamaUnavailability(): string | null {
  const config = ollamaConfig();
  try {
    new URL(config.baseUrl);
  } catch {
    return "OLLAMA_BASE_URL is not a valid URL.";
  }
  if (config.selfHosted) {
    // Saying "self-hosted" about Ollama's own cloud would send client
    // material to a third party under a label that says it stays in.
    if (!env("OLLAMA_BASE_URL") || isCloud(config.baseUrl)) {
      return "OLLAMA_SELF_HOSTED needs OLLAMA_BASE_URL to name your own Ollama server.";
    }
    return null;
  }
  if (isCloud(config.baseUrl) && !config.apiKey) return "Needs OLLAMA_API_KEY on the server.";
  return null;
}

/* ------------------------------------------------------------------ */
/* The wire format                                                     */
/* ------------------------------------------------------------------ */

export type OllamaToolCall = {
  function: { name: string; arguments: unknown; index?: number };
};

export type OllamaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; thinking?: string; tool_calls?: OllamaToolCall[] }
  | { role: "tool"; tool_name: string; content: string };

export type OllamaTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** One line of Ollama's stream. */
export type OllamaChunk = {
  model?: string;
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

/**
 * Why a model did not answer, in words a person can act on.
 *
 * The status is classified rather than passed through, because "429" on a
 * screen means nothing to whoever is reading it, and the failures that matter
 * most here — the usage limit is reached, and the key is wrong — have
 * different fixes.
 */
export class ChatError extends Error {
  constructor(
    message: string,
    /** Whether trying the other model could help. */
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

function errorFor(status: number, detail: string): ChatError {
  if (status === 401 || status === 403) {
    return new ChatError("The Ollama server refused the key. Check OLLAMA_API_KEY.", false, status);
  }
  if (status === 404) {
    // Ollama's answer for a model it does not have. The other may be there.
    return new ChatError(
      `That model is not on the Ollama server${detail ? `: ${detail}` : "."}`,
      true,
      status,
    );
  }
  if (status === 429) {
    return new ChatError(
      "This model is busy or the Ollama usage limit is reached for now.",
      true,
      status,
    );
  }
  if (status === 400 || status === 413) {
    return new ChatError(
      `The model would not take that conversation${detail ? `: ${detail}` : "."}`,
      false,
      status,
    );
  }
  // Every 5xx: the other model may be fine.
  return new ChatError(`The model is unavailable right now (${status}).`, true, status);
}

/**
 * Turn Ollama's stream into its chunks.
 *
 * The stream is newline-delimited JSON, one object per line, the last with
 * `done: true`. A line can split across two network chunks, so lines are only
 * parsed once their newline has arrived.
 *
 * An error can also arrive INSIDE a 200, as a line with an `error` field.
 * That is thrown, so it reaches the caller as a failure rather than as an
 * answer that simply stopped.
 *
 * Exported for the test; nothing else should need it.
 */
export async function* chunksFromStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OllamaChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      let newline: number;
      // At the end, a last line without its newline is still read.
      while ((newline = buffer.indexOf("\n")) !== -1 || (done && buffer.trim())) {
        if (newline === -1) newline = buffer.length;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let chunk: OllamaChunk & { error?: string };
        try {
          chunk = JSON.parse(line);
        } catch {
          continue; // a malformed line is skipped, not fatal
        }
        if (chunk.error) throw errorFor(502, chunk.error);
        yield chunk;
        if (chunk.done) return;
      }

      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The answer's words alone, for callers that want nothing else. */
export async function* textOf(chunks: AsyncIterable<OllamaChunk>): AsyncGenerator<string> {
  for await (const chunk of chunks) {
    const text = chunk.message?.content;
    if (text) yield text;
  }
}

/* ------------------------------------------------------------------ */
/* Which models are busy                                               */
/* ------------------------------------------------------------------ */

/**
 * When each model may be asked again, in epoch milliseconds.
 *
 * Kept in this process's memory, which is enough because the portal runs as
 * one Railway replica. A restart forgets it, and the cost of forgetting is
 * one wasted attempt per busy model before it is remembered again.
 */
const busyUntil = new Map<string, number>();

/** The model that most recently produced an answer. Tried first in auto. */
let lastGood: string | null = null;

/** Bounds on how long a model sits out after saying it is busy. */
const MIN_REST_MS = 15_000;
const MAX_REST_MS = 10 * 60_000;
/** For a busy answer that gives no hint of when to come back. */
const DEFAULT_REST_MS = 60_000;

/**
 * How long a model should sit out, from what the server said.
 *
 * A 429 may carry `Retry-After` (seconds); when it does not, a minute is a
 * fair guess. Clamped either way: a header that says "come back in a week"
 * still gets rechecked within ten minutes, in case the reading was wrong.
 */
export function restFor(res: Pick<Response, "headers"> | null): number {
  const retryAfter = Number(res?.headers.get("retry-after"));
  const ms = retryAfter > 0 ? retryAfter * 1000 : DEFAULT_REST_MS;
  return Math.min(MAX_REST_MS, Math.max(MIN_REST_MS, ms));
}

function markBusy(model: string, why: ChatError, res: Response | null) {
  const rest = restFor(res);
  busyUntil.set(model, Date.now() + rest);
  // The one line in the logs that says why an answer came from a different
  // model than the one picked. Railway keeps these; nothing else does.
  console.warn(
    `[ollama] ${model} skipped for ${Math.round(rest / 1000)}s: ` +
      `${why.status ?? "network"} ${why.message}`,
  );
}

function markGood(model: string) {
  busyUntil.delete(model);
  lastGood = model;
}

/** For tests: forget every busy mark and the last good model. */
export function resetModelHealth() {
  busyUntil.clear();
  lastGood = null;
}

/**
 * Which models to try, in order.
 *
 * Auto: the listed models, the one that answered last first, any that are
 * resting moved to the back. A resting model is moved back rather than
 * dropped — if everything is resting, trying it is still better than refusing
 * outright.
 *
 * A model named by the server's settings is tried first even while resting,
 * because someone chose it; the others follow in the order auto would use. A
 * name that is not on the list is tried alone, as asked.
 */
export function attemptOrder(choice: string, models = ollamaModels(), now = Date.now()): string[] {
  const resting = (id: string) => (busyUntil.get(id) ?? 0) > now;
  const ordered = [...models].sort((a, b) => {
    const rest = Number(resting(a)) - Number(resting(b));
    if (rest !== 0) return rest;
    return Number(b === lastGood) - Number(a === lastGood);
  });
  if (choice === AUTO) return ordered;
  return [choice, ...ordered.filter((id) => id !== choice)];
}

/* ------------------------------------------------------------------ */
/* Asking                                                              */
/* ------------------------------------------------------------------ */

/**
 * Start an answer from the first of `models` that will take it.
 *
 * Fallover only happens BEFORE anything has been produced. Once words are on
 * the screen, switching model would splice two different answers together, so
 * a failure after that point is reported as a cut-off instead.
 *
 * Returns the model that is actually answering, so the screen can say which
 * one it was rather than which one was asked for.
 */
export async function openChat(input: {
  models: string[];
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<{ model: string; chunks: AsyncGenerator<OllamaChunk> }> {
  const why = ollamaUnavailability();
  if (why) throw new ChatError(`Ollama is not set up: ${why}`, false);
  const { baseUrl, apiKey } = ollamaConfig();
  const doFetch = input.fetch ?? fetch;

  let last: ChatError | null = null;

  for (const model of input.models) {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: input.messages,
          ...(input.tools?.length ? { tools: input.tools } : {}),
        }),
        signal: input.signal,
      });
    } catch (err) {
      if (input.signal?.aborted) throw err;
      // One server serves every model, so the next would not be reached either.
      throw new ChatError("The Ollama server could not be reached.", true);
    }

    if (!res.ok || !res.body) {
      const detail = await res
        .json()
        .then((j: { error?: unknown }) => (typeof j.error === "string" ? j.error : ""))
        .catch(() => "");
      last = errorFor(res.status, detail);
      if (!last.retryable) throw last;
      markBusy(model, last, res);
      continue;
    }

    // Wait for the first line, so an error that arrives inside the 200 still
    // counts as "this model did not answer" and the next is tried.
    const chunks = chunksFromStream(res.body);
    let first: IteratorResult<OllamaChunk>;
    try {
      first = await chunks.next();
    } catch (err) {
      if (input.signal?.aborted) throw err;
      last =
        err instanceof ChatError
          ? err
          : new ChatError("The model stopped before answering.", true);
      if (!last.retryable) throw last;
      markBusy(model, last, null);
      continue;
    }

    markGood(model);
    async function* withFirst(): AsyncGenerator<OllamaChunk> {
      if (!first.done) yield first.value;
      yield* chunks;
    }
    return { model, chunks: withFirst() };
  }

  // Every model said busy or unavailable. Said as one plain sentence when
  // that is all it was; a missing model is worth naming, so it is passed on.
  if (last?.status === 404) throw last;
  throw new ChatError(
    "Every Ollama model is busy right now. Try again in a minute.",
    true,
    last?.status ?? null,
  );
}
