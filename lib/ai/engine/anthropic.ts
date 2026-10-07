import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  EngineError,
  roughTokens,
  type AgentEngine,
  type AgentEvent,
  type AgentRequest,
  type EngineCapability,
} from "./types";

/**
 * Claude, through the Anthropic API and its official SDK.
 *
 * A streaming manual tool loop rather than the SDK's tool runner, because the
 * workspace needs a receipt for every tool call — what was asked for, whether
 * it ran, what came back — and those are written by the caller from the
 * tool_start / tool_end events this yields.
 *
 * REFUSALS. Claude's safety classifiers can decline a request. The request
 * opts into Anthropic's server-side fallback (`fallbacks: "default"`), which
 * re-runs a declined request on the model Anthropic recommends for that kind
 * of decline, inside the same call. When that happens the answering model is
 * reported as a `model` event, so the receipt names the model that actually
 * answered. A refusal that survives the fallback is said plainly.
 */

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicEngine implements AgentEngine {
  readonly provider = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    private readonly opts: {
      apiKey: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      capabilities: EngineCapability[];
      /** For tests: answer the SDK's HTTP calls without the network. */
      fetch?: typeof fetch;
    },
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, maxRetries: 2 });
  }

  supports(capability: EngineCapability): boolean {
    return this.opts.capabilities.includes(capability);
  }

  async estimateUsage(request: AgentRequest) {
    return { inputTokens: roughTokens(request), approxCostUsd: null };
  }

  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    const tools: Anthropic.Beta.BetaTool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      // Inputs stream as they are generated; the server then stops checking
      // them, which is fine because every input is parsed below before use.
      eager_input_streaming: true,
    }));
    const byName = new Map(request.tools.map((t) => [t.name, t]));

    const messages: Anthropic.Beta.BetaMessageParam[] = request.history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const maxRounds = request.maxToolRounds ?? 8;
    let reportedModel = this.model;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let round = 0; ; round++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 64000,
          system: request.system,
          messages,
          ...(tools.length ? { tools } : {}),
          ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        { signal: request.signal },
      );

      let message: Anthropic.Beta.BetaMessage;
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          }
        }
        message = await stream.finalMessage();
      } catch (err) {
        throw classify(err);
      }

      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      if (message.model && message.model !== reportedModel) {
        reportedModel = message.model;
        yield { type: "model", model: message.model };
      }

      if (message.stop_reason === "refusal") {
        yield {
          type: "notice",
          level: "warning",
          message:
            "Claude declined this request, and the fallback model declined it too. " +
            "Rephrasing it, or asking for a narrower part of it, usually helps.",
        };
        break;
      }

      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        if (message.stop_reason === "max_tokens") {
          yield { type: "notice", level: "warning", message: "The answer reached its length limit and was cut short." };
        }
        break;
      }
      if (round >= maxRounds) {
        yield {
          type: "notice",
          level: "warning",
          message: `Stopped after ${maxRounds} rounds of looking things up. Ask a narrower question to go further.`,
        };
        break;
      }

      // Appended unchanged: earlier turns are never edited, so the history
      // stays valid for the model's own reasoning checks.
      messages.push({ role: "assistant", content: message.content });

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        yield { type: "tool_start", id: use.id, name: use.name, input: use.input };
        const tool = byName.get(use.name);
        const parsed = tool ? tool.parse(use.input) : ({ ok: false, error: `No tool named ${use.name}.` } as const);
        if (!tool || !parsed.ok) {
          const error = parsed.ok ? "Unknown tool." : parsed.error;
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: error });
          yield { type: "tool_end", id: use.id, name: use.name, ok: false, summary: error };
          continue;
        }
        try {
          const out = await tool.run(parsed.value);
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: out.isError ?? false, content: out.content });
          yield { type: "tool_end", id: use.id, name: use.name, ok: !out.isError, summary: summarise(out.content) };
        } catch (err) {
          const error = err instanceof Error ? err.message : "The tool failed.";
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: error });
          yield { type: "tool_end", id: use.id, name: use.name, ok: false, summary: error };
        }
      }
      messages.push({ role: "user", content: results });
    }

    yield { type: "usage", inputTokens, outputTokens };
  }
}

function summarise(content: string): string {
  return content.length > 160 ? `${content.slice(0, 157)}…` : content;
}

/** The SDK's typed errors, turned into sentences a person can act on. */
function classify(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new EngineError("The Anthropic API key was refused. Check ANTHROPIC_API_KEY.", false);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new EngineError("Claude is rate-limited right now. Try again in a minute.", true);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new EngineError(`Claude could not take that request: ${err.message}`, false);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new EngineError("Claude could not be reached.", true);
  }
  if (err instanceof Anthropic.APIError) {
    return new EngineError(`Claude returned an error (${err.status ?? "unknown"}).`, true);
  }
  return err instanceof Error ? err : new Error(String(err));
}
