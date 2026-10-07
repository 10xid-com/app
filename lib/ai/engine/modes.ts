import type { EngineCapability, Provider } from "./types";

/**
 * The engine modes a person chooses between, and what each one means.
 *
 * Client-safe: labels and purposes only. Which model a mode runs is read from
 * the environment on the server (lib/ai/engine/registry.ts), so moving
 * "Claude — Coding" to a newer model is a Railway variable, not a redesign —
 * the person still picks "Claude — Coding".
 *
 * The OpenAI modes have no default model on purpose. Naming one here would be
 * a guess about somebody else's catalogue; until an administrator sets
 * OPENAI_MODEL_MULTIMODAL / OPENAI_MODEL_REVIEW, those modes show as not set
 * up rather than calling a model nobody chose.
 */

export type EngineModeId =
  | "claude-coding"
  | "claude-deep"
  | "openai-multimodal"
  | "openai-review"
  /** Ollama, any model ("auto"). Kept under its old id so existing conversations carry over. */
  | "prototype-free"
  | "ollama-self-hosted"
  /** Ollama, one named model. Built from the server's model list (ollamaModelSpec). */
  | `ollama:${string}`;

export type EngineModeSpec = {
  id: EngineModeId;
  label: string;
  provider: Provider;
  /** One line shown under the label: what this mode is for. */
  purpose: string;
  /** The variable naming the model, and the model used when it is unset. */
  modelEnv?: string;
  defaultModel: string | null;
  /**
   * The mode whose client policy also governs this one. A per-model Ollama
   * entry answers to its Auto mode's policy, so withholding Auto from a
   * client withholds every model under it.
   */
  policyMode?: EngineModeId;
  /** Claude only: how hard the model thinks. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  capabilities: EngineCapability[];
};

const CLAUDE_CAPS: EngineCapability[] = [
  "text",
  "images",
  "documents",
  "video_derived",
  "tool_calling",
  "structured_output",
  "long_repository_context",
  "streaming",
];

const OPENAI_CAPS: EngineCapability[] = [
  "text",
  "images",
  "documents",
  "video_derived",
  "tool_calling",
  "structured_output",
  "streaming",
];

export const ENGINE_MODES: EngineModeSpec[] = [
  {
    id: "claude-coding",
    label: "Claude — Coding",
    provider: "anthropic",
    purpose: "Repository exploration, coding plans and code questions. The default.",
    modelEnv: "CLAUDE_MODEL_CODING",
    defaultModel: "claude-opus-5-5",
    effort: "medium",
    capabilities: CLAUDE_CAPS,
  },
  {
    id: "claude-deep",
    label: "Claude — Deep analysis",
    provider: "anthropic",
    purpose: "Harder questions that are worth more thinking time and cost.",
    modelEnv: "CLAUDE_MODEL_DEEP",
    defaultModel: "claude-opus-5-5",
    effort: "high",
    capabilities: CLAUDE_CAPS,
  },
  {
    id: "openai-multimodal",
    label: "OpenAI — Multimodal",
    provider: "openai",
    purpose: "Work centred on images and documents.",
    modelEnv: "OPENAI_MODEL_MULTIMODAL",
    defaultModel: null,
    capabilities: OPENAI_CAPS,
  },
  {
    id: "openai-review",
    label: "OpenAI — Review",
    provider: "openai",
    purpose: "A second opinion on a plan or an answer.",
    modelEnv: "OPENAI_MODEL_REVIEW",
    defaultModel: null,
    capabilities: OPENAI_CAPS,
  },
  {
    id: "prototype-free",
    label: "Ollama — Auto",
    provider: "ollama",
    purpose:
      "Ollama Cloud models, for trying the workspace out. Text only: no jobs, files or attachments are sent.",
    defaultModel: "auto",
    capabilities: ["text", "streaming"],
  },
  {
    id: "ollama-self-hosted",
    label: "Ollama — Auto (self-hosted)",
    provider: "ollama",
    purpose: "Models on our own Ollama server. Can look up this client's records; nothing leaves our infrastructure.",
    defaultModel: "auto",
    capabilities: ["text", "tool_calling", "streaming"],
  },
];

export function modeSpec(id: string): EngineModeSpec | undefined {
  return ENGINE_MODES.find((m) => m.id === id);
}

/**
 * What the picker calls each Ollama model, with whose model it is — people
 * look for "OpenAI" or "Google", not "gpt-oss". A model on the server's list
 * that is missing here is shown by its own name.
 */
const OLLAMA_LABELS: Record<string, string> = {
  "gpt-oss:120b": "gpt-oss 120B (OpenAI)",
  "gpt-oss:20b": "gpt-oss 20B (OpenAI)",
  "gemma4:31b": "Gemma 4 31B (Google)",
  "kimi-k2.7-code": "Kimi K2.7 Code (Moonshot AI)",
};

/**
 * One Ollama model as its own picker entry. It answers with that model or not
 * at all: someone who picked Gemma by name should not be handed gpt-oss. The
 * rest — fences, tools, purpose — is the Auto mode's it is built from.
 */
export function ollamaModelSpec(base: EngineModeSpec, model: string): EngineModeSpec {
  return {
    ...base,
    id: `ollama:${model}`,
    label: `Ollama — ${OLLAMA_LABELS[model] ?? model}`,
    policyMode: base.id,
    modelEnv: undefined,
    defaultModel: model,
  };
}

/** What the person sees in the picker, computed on the server. */
export type EngineModeOption = {
  id: EngineModeId;
  label: string;
  purpose: string;
  provider: Provider;
  available: boolean;
  /** Why it is unavailable, when it is. */
  reason: string | null;
  canUseTools: boolean;
};
