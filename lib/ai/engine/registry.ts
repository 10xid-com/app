import "server-only";
import { AnthropicEngine } from "./anthropic";
import { OpenAIEngine } from "./openai";
import { OllamaEngine } from "./ollama";
import { ENGINE_MODES, modeSpec, ollamaModelSpec, type EngineModeOption, type EngineModeSpec } from "./modes";
import type { AgentEngine } from "./types";
import { ollamaConfig, ollamaModels, ollamaUnavailability } from "../ollama";

/**
 * Which engine modes exist on this server, which a given client may use, and
 * the engine behind each.
 *
 * THE ROUTING POLICY, in one place:
 *   - Claude — Coding is the default for Ask and Plan, when it is set up.
 *   - OpenAI modes are offered when configured, for multimodal work and second
 *     opinions; the person picks them, nothing switches to them silently.
 *   - One run goes to ONE provider. Nothing here fans a request out to two,
 *     so the same client context is never sent to both without a person
 *     choosing a comparison (which does not exist yet).
 *   - A client can be kept off a mode by an engine_mode_policies row.
 *   - The Ollama prototype (Ollama Cloud, a third party) never receives
 *     tools, and is refused once a conversation has any context attached.
 *   - Ollama self-hosted gets tools and context like Claude and OpenAI, and
 *     exists only when OLLAMA_SELF_HOSTED=true says the server is ours. It
 *     replaces the prototype: both would talk to the same server.
 *   - Each Ollama model on the server's list is also its own entry, with the
 *     same fences as the Auto mode it is built from.
 *   - Keys and model names come from the server's environment only.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function modelFor(spec: EngineModeSpec): string | null {
  return (spec.modelEnv ? env(spec.modelEnv) : undefined) ?? spec.defaultModel;
}

/**
 * Every mode this server knows: the fixed ones, then one per Ollama model,
 * built from whichever Ollama mode the server runs (self-hosted or Cloud).
 */
function allModes(): EngineModeSpec[] {
  const base = modeSpec(ollamaConfig().selfHosted ? "ollama-self-hosted" : "prototype-free")!;
  return [...ENGINE_MODES, ...ollamaModels().map((m) => ollamaModelSpec(base, m))];
}

/** A mode by id, including the per-model Ollama ones. */
export function findMode(id: string): EngineModeSpec | undefined {
  return allModes().find((m) => m.id === id);
}

/** Why a mode cannot run on this server at all, or null when it can. */
function serverUnavailability(spec: EngineModeSpec): string | null {
  switch (spec.provider) {
    case "anthropic":
      return env("ANTHROPIC_API_KEY") ? null : "Needs ANTHROPIC_API_KEY on the server.";
    case "openai":
      if (!env("OPENAI_API_KEY")) return "Needs OPENAI_API_KEY on the server.";
      return modelFor(spec) ? null : `Needs ${spec.modelEnv} to name the model.`;
    case "ollama": {
      const selfHosted = ollamaConfig().selfHosted;
      if (spec.id === "ollama-self-hosted" && !selfHosted) {
        return "Needs OLLAMA_SELF_HOSTED=true and your own Ollama server.";
      }
      if (spec.id === "prototype-free" && selfHosted) return "Replaced by the self-hosted Ollama server.";
      if (!selfHosted && env("ENABLE_PROTOTYPE_ENGINE") !== "true") return "Prototype engine is switched off.";
      return ollamaUnavailability();
    }
  }
}

/** Whether a client's policy withholds a mode, directly or through its Auto mode. */
function isWithheld(spec: EngineModeSpec, withheld: Set<string>): boolean {
  return withheld.has(spec.id) || (spec.policyMode !== undefined && withheld.has(spec.policyMode));
}

/** Whether a mode is worth listing at all; the rest are noise when off. */
function listed(spec: EngineModeSpec): boolean {
  if (spec.provider !== "ollama") return true;
  const selfHosted = ollamaConfig().selfHosted;
  if (spec.id === "prototype-free") return env("ENABLE_PROTOTYPE_ENGINE") === "true" && !selfHosted;
  if (spec.id === "ollama-self-hosted") return selfHosted;
  return selfHosted || env("ENABLE_PROTOTYPE_ENGINE") === "true";
}

/**
 * What the picker shows for one client: every mode, with whether it can be
 * used and why not.
 */
export function modeOptions(withheld: Set<string>): EngineModeOption[] {
  return allModes().filter(listed).map((m) => {
    const server = serverUnavailability(m);
    const reason = server ?? (isWithheld(m, withheld) ? "Not permitted for this client." : null);
    return {
      id: m.id,
      label: m.label,
      purpose: m.purpose,
      provider: m.provider,
      available: reason === null,
      reason,
      canUseTools: m.capabilities.includes("tool_calling"),
    };
  });
}

/** The mode a new conversation starts in: Claude — Coding when possible. */
export function defaultMode(options: EngineModeOption[]): string | null {
  const preferred = ["claude-coding", "claude-deep", "openai-review", "openai-multimodal", "ollama-self-hosted", "prototype-free"];
  for (const id of preferred) {
    if (options.find((o) => o.id === id)?.available) return id;
  }
  return null;
}

/**
 * Build the engine for a mode, or explain why not. `hasContext` is whether the
 * conversation carries client material the prototype must never receive.
 */
export function engineFor(
  modeId: string,
  withheld: Set<string>,
  opts: { hasContext: boolean; fetch?: typeof fetch } = { hasContext: false },
): { engine: AgentEngine; spec: EngineModeSpec } | { error: string } {
  const spec = findMode(modeId);
  if (!spec) return { error: "That engine mode does not exist." };
  const why = serverUnavailability(spec) ?? (isWithheld(spec, withheld) ? "Not permitted for this client." : null);
  if (why) return { error: `${spec.label} is not available: ${why}` };
  const model = modelFor(spec)!;

  switch (spec.provider) {
    case "anthropic":
      return {
        spec,
        engine: new AnthropicEngine(model, {
          apiKey: env("ANTHROPIC_API_KEY")!,
          effort: spec.effort,
          capabilities: spec.capabilities,
          fetch: opts.fetch,
        }),
      };
    case "openai":
      return {
        spec,
        engine: new OpenAIEngine(model, {
          apiKey: env("OPENAI_API_KEY")!,
          store: env("OPENAI_STORE") === "true",
          capabilities: spec.capabilities,
          fetch: opts.fetch,
        }),
      };
    case "ollama":
      // Without tools it is the Ollama Cloud prototype, and keeps its fence.
      if (!spec.capabilities.includes("tool_calling") && opts.hasContext) {
        return {
          error:
            "The prototype engine cannot be used once a conversation has jobs, files or attachments in it. " +
            "Choose Claude or OpenAI.",
        };
      }
      return { spec, engine: new OllamaEngine(model, { capabilities: spec.capabilities, fetch: opts.fetch }) };
  }
}
