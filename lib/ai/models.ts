/**
 * The models the chat may use, and nothing else.
 *
 * Client-safe on purpose: the chat box needs the labels to draw its picker, and
 * this file holds no key and no URL, so importing it into the browser bundle
 * publishes nothing. The key lives in lib/ai/openrouter.ts, which is
 * server-only.
 *
 * Both are OpenRouter's `:free` variants, chosen 2026-10-01 from the live model
 * list (pricing 0/0). Free means rate-limited: OpenRouter caps free requests
 * per minute and per day, and a busy free model answers 429. That is why there
 * are two, and why "auto" exists — see lib/ai/openrouter.ts for how a busy
 * model is skipped.
 *
 * The id is what the request body carries and what the route checks against,
 * so a caller cannot name a paid model and spend the account down.
 */
export const CHAT_MODELS = [
  { id: "qwen/qwen3.8-27b:free", label: "Qwen 3.8 27B" },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B" },
] as const;

export type ChatModelId = (typeof CHAT_MODELS)[number]["id"];

export const CHAT_MODEL_IDS = CHAT_MODELS.map((m) => m.id) as [
  ChatModelId,
  ...ChatModelId[],
];

/**
 * The last resort when both models above are busy: OpenRouter's own router,
 * which picks at random among whatever free models are answering right now.
 *
 * Not offered in the picker, because nobody can say in advance what it will
 * be — the answer is labelled with the model it actually reached. Priced 0/0
 * like the others (checked 2026-10-01), and it only routes to free models.
 */
export const FREE_ROUTER = "openrouter/free";

/** "Use whichever free model is answering." The picker's default. */
export const AUTO = "auto";

export type ChatChoice = typeof AUTO | ChatModelId;

export const CHAT_CHOICES = [AUTO, ...CHAT_MODEL_IDS] as [
  ChatChoice,
  ...ChatChoice[],
];

/**
 * A readable name for whatever answered.
 *
 * The free router reports the model it reached, which can be anything free on
 * OpenRouter, so an id not in the list above is shown as its own name rather
 * than hidden: "meta-llama/llama-5-8b:free" is more use to a reader than
 * "some other model".
 */
export function modelLabel(id: string): string {
  if (id === AUTO) return "Auto";
  if (id === FREE_ROUTER) return "Any free model";
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? id;
}
