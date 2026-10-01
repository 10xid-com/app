import "server-only";
import { AnthropicEngine } from "./anthropic";
import { OpenAIEngine } from "./openai";
import { PrototypeEngine } from "./prototype";
import { ENGINE_MODES, modeSpec, type EngineModeOption, type EngineModeSpec } from "./modes";
import type { AgentEngine } from "./types";

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
 *   - The prototype engine never receives tools, and is refused once a
 *     conversation has any context attached.
 *   - Keys and model names come from the server's environment only.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function modelFor(spec: EngineModeSpec): string | null {
  return env(spec.modelEnv) ?? spec.defaultModel;
}

/** Why a mode cannot run on this server at all, or null when it can. */
function serverUnavailability(spec: EngineModeSpec): string | null {
  switch (spec.provider) {
    case "anthropic":
      return env("ANTHROPIC_API_KEY") ? null : "Needs ANTHROPIC_API_KEY on the server.";
    case "openai":
      if (!env("OPENAI_API_KEY")) return "Needs OPENAI_API_KEY on the server.";
      return modelFor(spec) ? null : `Needs ${spec.modelEnv} to name the model.`;
    case "openrouter":
      if (env("ENABLE_PROTOTYPE_ENGINE") !== "true") return "Prototype engine is switched off.";
      return env("OPENROUTER_API_KEY") ? null : "Needs OPENROUTER_API_KEY on the server.";
  }
}

/**
 * What the picker shows for one client: every mode, with whether it can be
 * used and why not.
 */
export function modeOptions(withheld: Set<string>): EngineModeOption[] {
  return ENGINE_MODES.filter(
    // The prototype is listed only when switched on; otherwise it is noise.
    (m) => m.provider !== "openrouter" || env("ENABLE_PROTOTYPE_ENGINE") === "true",
  ).map((m) => {
    const server = serverUnavailability(m);
    const reason = server ?? (withheld.has(m.id) ? "Not permitted for this client." : null);
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
  const preferred = ["claude-coding", "claude-deep", "openai-review", "openai-multimodal", "prototype-free"];
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
  const spec = modeSpec(modeId);
  if (!spec) return { error: "That engine mode does not exist." };
  const why = serverUnavailability(spec) ?? (withheld.has(spec.id) ? "Not permitted for this client." : null);
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
    case "openrouter":
      if (opts.hasContext) {
        return {
          error:
            "The prototype engine cannot be used once a conversation has jobs, files or attachments in it. " +
            "Choose Claude or OpenAI.",
        };
      }
      return { spec, engine: new PrototypeEngine(model) };
  }
}
