import "server-only";
import {
  AUTO,
  CHAT_MODEL_IDS,
  FREE_ROUTER,
  type ChatChoice,
} from "./models";

/**
 * The one place the portal talks to an AI model.
 *
 * OpenRouter rather than a provider's own API, because one key reaches both
 * free models in lib/ai/models.ts and swapping a model is a one-line change
 * there rather than a new client library. Plain fetch against its
 * OpenAI-compatible endpoint, for the same reason the rest of this codebase
 * pins its dependencies exactly: an SDK is a second version number to keep in
 * step, and this is one POST and an event stream.
 *
 * Inert without OPENROUTER_API_KEY, like the other integrations: the chat page
 * says it is not set up rather than half-working.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Said once, at the top of every conversation, by us rather than the person.
 * Short on purpose — the free models are small, and every line here is read
 * again on every turn.
 */
const SYSTEM_PROMPT =
  "You are a helpful assistant for the staff of Branding Centres, a design " +
  "and marketing agency, working inside their 10XiD portal. Be direct and " +
  "practical. When asked to draft something, draft it rather than describing " +
  "how you would.";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export function chatIsConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * Why a model did not answer, in words a person can act on.
 *
 * The status is classified rather than passed through, because "429" on a
 * screen means nothing to whoever is reading it, and the two failures that
 * matter most here — the free allowance is used up, and the key is wrong —
 * have different fixes.
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
    return new ChatError(
      "The OpenRouter key was refused. Check OPENROUTER_API_KEY.",
      false,
      status,
    );
  }
  if (status === 402) {
    return new ChatError(
      "OpenRouter says the account needs credit before it will answer.",
      false,
      status,
    );
  }
  if (status === 429) {
    return new ChatError(
      "This free model is busy or today's free allowance is used up.",
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
  // 404 (the model was withdrawn) and every 5xx: the other model may be fine.
  return new ChatError(
    `The model is unavailable right now (${status}).`,
    true,
    status,
  );
}

/**
 * Turn OpenRouter's event stream into the text it carries.
 *
 * The stream is Server-Sent Events: `data: {json}` lines, a `data: [DONE]` at
 * the end, and `: OPENROUTER PROCESSING` comment lines while a free model
 * queues. A JSON payload can split across two network chunks, so lines are
 * only parsed once their newline has arrived.
 *
 * An error can also arrive INSIDE a 200 — the upstream provider gave up after
 * OpenRouter had already answered — as a chunk with an `error` field. That is
 * thrown, so it reaches the caller as a failure rather than as an answer that
 * simply stopped.
 *
 * Exported for the test; nothing else should need it.
 */
export async function* textFromEventStream(
  body: ReadableStream<Uint8Array>,
  /**
   * Told the model each chunk says produced it. Matters for the free router,
   * which is asked for "openrouter/free" and answers as whatever it reached.
   */
  onModel?: (model: string) => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (!line.startsWith("data:")) continue; // comments, blank lines
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;

        let event: {
          model?: string;
          error?: { message?: string; code?: number };
          choices?: { delta?: { content?: string | null } }[];
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue; // a malformed line is skipped, not fatal
        }

        if (event.model) onModel?.(event.model);
        if (event.error) {
          const status = Number(event.error.code) || 502;
          throw errorFor(status, event.error.message ?? "");
        }
        const text = event.choices?.[0]?.delta?.content;
        if (text) yield text;
      }

      if (done) return;
    }
  } finally {
    reader.releaseLock();
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
 * How long a model should sit out, from what OpenRouter said.
 *
 * A 429 may carry `Retry-After` (seconds) or `X-RateLimit-Reset` (epoch
 * milliseconds); when neither is there a minute is a fair guess at a
 * per-minute limit. Clamped either way: a header that says "come back in a
 * week" — a daily allowance that is spent — still gets rechecked within ten
 * minutes, in case the reading was wrong.
 */
export function restFor(res: Pick<Response, "headers"> | null, now = Date.now()): number {
  let ms = DEFAULT_REST_MS;
  const retryAfter = Number(res?.headers.get("retry-after"));
  const reset = Number(res?.headers.get("x-ratelimit-reset"));
  if (retryAfter > 0) ms = retryAfter * 1000;
  else if (reset > now) ms = reset - now;
  return Math.min(MAX_REST_MS, Math.max(MIN_REST_MS, ms));
}

function markBusy(model: string, why: ChatError, res: Response | null) {
  const rest = restFor(res);
  busyUntil.set(model, Date.now() + rest);
  // The one line in the logs that says why an answer came from a different
  // model than the one picked. Railway keeps these; nothing else does.
  console.warn(
    `[chat] ${model} skipped for ${Math.round(rest / 1000)}s: ` +
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
 * Auto: the two named models, the one that answered last first, any that are
 * resting moved to the back; then the free router as the backstop. A resting
 * model is moved back rather than dropped — if everything is resting, trying
 * it is still better than refusing outright.
 *
 * A model picked by hand is tried first even while resting, because the
 * person asked for it; the others follow in the same order auto would use.
 */
export function attemptOrder(choice: ChatChoice, now = Date.now()): string[] {
  const resting = (id: string) => (busyUntil.get(id) ?? 0) > now;
  const named = [...CHAT_MODEL_IDS].sort((a, b) => {
    const rest = Number(resting(a)) - Number(resting(b));
    if (rest !== 0) return rest;
    return Number(b === lastGood) - Number(a === lastGood);
  });

  const order: string[] =
    choice === AUTO ? named : [choice, ...named.filter((id) => id !== choice)];
  order.push(FREE_ROUTER);
  return order;
}

/* ------------------------------------------------------------------ */
/* Asking                                                              */
/* ------------------------------------------------------------------ */

/**
 * Start an answer from whichever free model will take it.
 *
 * Fallover only happens BEFORE any text has been produced. Once words are on
 * the screen, switching model would splice two different answers together, so
 * a failure after that point is reported as a cut-off instead.
 *
 * Returns the model that is actually answering, so the screen can say which
 * one it was rather than which one was asked for. For the free router that is
 * the model it reached, as the stream reports it.
 */
export async function startChat(input: {
  model: ChatChoice;
  messages: ChatMessage[];
  signal?: AbortSignal;
}): Promise<{ model: string; text: AsyncGenerator<string> }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new ChatError("The chat is not set up yet.", false);

  let last: ChatError | null = null;

  for (const model of attemptOrder(input.model)) {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // Optional attribution headers OpenRouter reads for its own
          // dashboard. They say which app made the call, nothing about who.
          "HTTP-Referer": `https://${process.env.PRIMARY_HOST ?? "login.10xid.com"}`,
          "X-Title": "10XiD Portal",
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...input.messages],
        }),
        signal: input.signal,
      });
    } catch (err) {
      if (input.signal?.aborted) throw err;
      last = new ChatError("OpenRouter could not be reached.", true);
      continue;
    }

    if (!res.ok || !res.body) {
      const detail = await res
        .json()
        .then((j: { error?: { message?: string } }) => j.error?.message ?? "")
        .catch(() => "");
      last = errorFor(res.status, detail);
      if (!last.retryable) throw last;
      markBusy(model, last, res);
      continue;
    }

    // Wait for the first piece of text, so an error that arrives inside the
    // 200 still counts as "this model did not answer" and the next is tried.
    let reported = model;
    const text = textFromEventStream(res.body, (m) => (reported = m));
    let first: IteratorResult<string>;
    try {
      first = await text.next();
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
    async function* withFirst(): AsyncGenerator<string> {
      if (!first.done) yield first.value;
      yield* text;
    }
    // The router names what it reached; a named model names itself, and is
    // reported by the id we asked for so it matches the picker exactly.
    return { model: model === FREE_ROUTER ? reported : model, text: withFirst() };
  }

  // Every model, the backstop included, said busy or unavailable. Said as
  // one plain sentence: which of three refusals came last tells nobody
  // anything they can act on.
  throw new ChatError(
    "Every free model is busy right now. Try again in a minute.",
    true,
    last?.status ?? null,
  );
}
