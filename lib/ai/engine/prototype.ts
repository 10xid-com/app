import "server-only";
import { AUTO, CHAT_CHOICES, type ChatChoice } from "../models";
import { startChat } from "../openrouter";
import {
  EngineError,
  roughTokens,
  type AgentEngine,
  type AgentEvent,
  type AgentRequest,
  type EngineCapability,
} from "./types";

/**
 * The free OpenRouter models, kept as a PROTOTYPE engine.
 *
 * The workspace is built for Claude and OpenAI. This exists so the workspace
 * can be tried before those accounts are paid for, and it is fenced off from
 * everything that matters: it can call no tools, so it reads no jobs, files or
 * attachments — free providers may keep what they are sent. The router
 * (lib/ai/engine/registry.ts) also refuses it whenever a conversation has
 * context attached. Off unless ENABLE_PROTOTYPE_ENGINE=true.
 */
export class PrototypeEngine implements AgentEngine {
  readonly provider = "openrouter" as const;
  private static readonly CAPS: EngineCapability[] = ["text", "streaming"];

  constructor(readonly model: string) {}

  supports(capability: EngineCapability): boolean {
    return PrototypeEngine.CAPS.includes(capability);
  }

  async estimateUsage(request: AgentRequest) {
    return { inputTokens: roughTokens(request), approxCostUsd: 0 };
  }

  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (request.tools.length > 0) {
      throw new EngineError("The prototype engine cannot use tools.", false);
    }
    const choice: ChatChoice = (CHAT_CHOICES as readonly string[]).includes(this.model)
      ? (this.model as ChatChoice)
      : AUTO;
    let started;
    try {
      started = await startChat({
        model: choice,
        // The prototype keeps the free chat's own short system prompt; the
        // workspace's instructions are passed as the first user turn's preface
        // so Ask and Plan still mean something here.
        messages: [
          { role: "user", content: `${request.system}\n\n---\n` },
          { role: "assistant", content: "Understood." },
          ...request.history,
        ],
        signal: request.signal,
      });
    } catch (err) {
      throw new EngineError(err instanceof Error ? err.message : "No free model could answer.", true);
    }
    yield { type: "model", model: started.model };
    for await (const text of started.text) yield { type: "text", text };
    yield { type: "usage", inputTokens: 0, outputTokens: 0 };
  }
}
