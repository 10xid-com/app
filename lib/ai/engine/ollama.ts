import "server-only";
import {
  AUTO,
  ChatError,
  attemptOrder,
  openChat,
  type OllamaMessage,
  type OllamaTool,
  type OllamaToolCall,
} from "../ollama";
import {
  EngineError,
  roughTokens,
  type AgentEngine,
  type AgentEvent,
  type AgentRequest,
  type EngineCapability,
} from "./types";

/**
 * Ollama models, as two modes (lib/ai/engine/modes.ts):
 *
 *   - The PROTOTYPE, on Ollama Cloud. Fenced off from everything that
 *     matters: it is given no tools, so it reads no jobs, files or
 *     attachments, and the router refuses it whenever a conversation has
 *     context attached — Ollama Cloud is a third party.
 *   - SELF-HOSTED, on a server we run. Nothing sent to it leaves our own
 *     infrastructure, so it gets the tools the Claude and OpenAI modes get.
 *
 * Which one this is depends only on `capabilities`, which the router sets
 * from the mode; the engine itself refuses tools it was not given leave for.
 */
export class OllamaEngine implements AgentEngine {
  readonly provider = "ollama" as const;

  constructor(
    readonly model: string,
    private readonly opts: { capabilities: EngineCapability[]; fetch?: typeof fetch },
  ) {}

  supports(capability: EngineCapability): boolean {
    return this.opts.capabilities.includes(capability);
  }

  async estimateUsage(request: AgentRequest) {
    // Ollama Cloud is a flat subscription and a self-hosted server is ours:
    // neither is billed per token.
    return { inputTokens: roughTokens(request), approxCostUsd: 0 };
  }

  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (request.tools.length > 0 && !this.supports("tool_calling")) {
      throw new EngineError("This Ollama mode cannot use tools.", false);
    }
    const tools: OllamaTool[] = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const byName = new Map(request.tools.map((t) => [t.name, t]));

    const messages: OllamaMessage[] = [
      { role: "system", content: request.system },
      ...request.history,
    ];

    const maxRounds = request.maxToolRounds ?? 8;
    let inputTokens = 0;
    let outputTokens = 0;
    // Chosen on the first round, then kept: one answer comes from one model.
    let answering: string | null = null;

    for (let round = 0; ; round++) {
      let started;
      try {
        started = await openChat({
          models: answering ? [answering] : attemptOrder(this.model),
          messages,
          tools,
          signal: request.signal,
          fetch: this.opts.fetch,
        });
      } catch (err) {
        throw classify(err);
      }
      if (!answering) {
        answering = started.model;
        if (answering !== this.model || this.model === AUTO) {
          yield { type: "model", model: answering };
        }
      }

      let content = "";
      let thinking = "";
      const calls: OllamaToolCall[] = [];
      let doneReason: string | undefined;
      try {
        for await (const chunk of started.chunks) {
          const text = chunk.message?.content;
          if (text) {
            content += text;
            yield { type: "text", text };
          }
          if (chunk.message?.thinking) thinking += chunk.message.thinking;
          if (chunk.message?.tool_calls) calls.push(...chunk.message.tool_calls);
          if (chunk.done) {
            doneReason = chunk.done_reason;
            inputTokens += chunk.prompt_eval_count ?? 0;
            outputTokens += chunk.eval_count ?? 0;
          }
        }
      } catch (err) {
        throw classify(err);
      }
      if (doneReason === "length") {
        yield { type: "notice", level: "warning", message: "The answer was cut short before it finished." };
      }

      if (calls.length === 0) break;
      if (round >= maxRounds) {
        yield {
          type: "notice",
          level: "warning",
          message: `Stopped after ${maxRounds} rounds of looking things up. Ask a narrower question to go further.`,
        };
        break;
      }

      // Thinking goes back with the turn it belongs to: Ollama's reasoning
      // models expect to see it again when the tool results arrive.
      messages.push({
        role: "assistant",
        content,
        ...(thinking ? { thinking } : {}),
        tool_calls: calls,
      });

      for (const [i, call] of calls.entries()) {
        // Ollama gives tool calls no id; one is made so start and end pair up.
        const id = `call_${round}_${i}`;
        const name = call.function.name;
        let raw = call.function.arguments;
        if (typeof raw === "string") {
          try {
            raw = JSON.parse(raw);
          } catch {
            raw = undefined;
          }
        }
        yield { type: "tool_start", id, name, input: raw };
        const tool = byName.get(name);
        const parsed = tool ? tool.parse(raw) : ({ ok: false, error: `No tool named ${name}.` } as const);
        let output: string;
        let ok = true;
        if (!tool || !parsed.ok) {
          output = parsed.ok ? "Unknown tool." : parsed.error;
          ok = false;
        } else {
          try {
            const out = await tool.run(parsed.value);
            output = out.content;
            ok = !out.isError;
          } catch (err) {
            output = err instanceof Error ? err.message : "The tool failed.";
            ok = false;
          }
        }
        messages.push({ role: "tool", tool_name: name, content: output });
        yield {
          type: "tool_end",
          id,
          name,
          ok,
          summary: output.length > 160 ? `${output.slice(0, 157)}…` : output,
        };
      }
    }

    yield { type: "usage", inputTokens, outputTokens };
  }
}

function classify(err: unknown): Error {
  if (err instanceof ChatError) return new EngineError(err.message, err.retryable);
  return err instanceof Error ? err : new Error(String(err));
}
