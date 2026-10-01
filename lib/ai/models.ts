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
 * are two — when the one you picked is throttled, the other is tried before the
 * failure reaches the screen.
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

export function modelLabel(id: string): string {
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? id;
}
