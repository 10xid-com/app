/**
 * The provider-neutral shape every engine speaks.
 *
 * The workspace never imports a provider SDK. It asks an AgentEngine to stream
 * a request and reads AgentEvents back, so adding a provider, or changing a
 * model, is a new implementation of this file's interface and nothing else.
 * Claude and OpenAI are the two engines this is built for; the free OpenRouter
 * models are a third, kept as a prototype (lib/ai/engine/modes.ts).
 */

export type EngineCapability =
  | "text"
  | "images"
  | "documents"
  /** Frames or a transcript extracted from a video — never the video itself. */
  | "video_derived"
  | "tool_calling"
  | "structured_output"
  | "long_repository_context"
  | "streaming";

export type Provider = "anthropic" | "openai" | "openrouter";

export type HistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * A tool the model may call. Defined once, here, and translated by each
 * engine into its provider's format.
 *
 * `parse` is the gate between what the model produced and what runs: model
 * output is untrusted, so input that does not validate is answered with an
 * error result and never reaches `run`.
 */
export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema for the input, as the providers expect it. */
  inputSchema: Record<string, unknown>;
  parse(input: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  run(input: unknown): Promise<{ content: string; isError?: boolean }>;
};

export type AgentRequest = {
  system: string;
  history: HistoryMessage[];
  tools: AgentTool[];
  signal?: AbortSignal;
  /** The most tool round-trips one answer may take before it must stop. */
  maxToolRounds?: number;
};

export type AgentEvent =
  /** Words of the answer, in order. */
  | { type: "text"; text: string }
  /** The model that is actually answering, when it differs from the one asked for. */
  | { type: "model"; model: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string }
  /** Something the person should know that is not part of the answer. */
  | { type: "notice"; level: "info" | "warning"; message: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export type UsageEstimate = {
  inputTokens: number;
  /** Null when the engine has no price configured. */
  approxCostUsd: number | null;
};

export interface AgentEngine {
  readonly provider: Provider;
  readonly model: string;
  stream(request: AgentRequest): AsyncIterable<AgentEvent>;
  supports(capability: EngineCapability): boolean;
  estimateUsage(request: AgentRequest): Promise<UsageEstimate>;
}

/**
 * A failure an engine could not recover from, in words a person can act on.
 * `retryable` says whether trying again later could help.
 */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * A rough input-size estimate: about four characters a token for English and
 * code. Good enough to warn before an expensive request, never to bill by.
 */
export function roughTokens(request: AgentRequest): number {
  const chars =
    request.system.length +
    request.history.reduce((n, m) => n + m.content.length, 0) +
    request.tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);
  return Math.ceil(chars / 4);
}
