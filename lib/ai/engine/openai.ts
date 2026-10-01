import "server-only";
import OpenAI from "openai";
import {
  EngineError,
  roughTokens,
  type AgentEngine,
  type AgentEvent,
  type AgentRequest,
  type EngineCapability,
} from "./types";

/**
 * OpenAI models, through the OpenAI API (Responses API) and its official SDK.
 *
 * Internally this is "the OpenAI API provider", never "ChatGPT": ChatGPT is a
 * consumer product with its own terms, and this is the developer API billed
 * per use. The picker may say "OpenAI" because that is what people recognise.
 *
 * RETENTION. Responses are not stored at OpenAI unless OPENAI_STORE=true, so
 * each turn resends its own context instead of pointing at a stored response.
 * Reasoning items are left out of what is sent back: without storage they
 * cannot be replayed, and the answer does not depend on them.
 */
export class OpenAIEngine implements AgentEngine {
  readonly provider = "openai" as const;
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    private readonly opts: {
      apiKey: string;
      store: boolean;
      capabilities: EngineCapability[];
      fetch?: typeof fetch;
    },
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, fetch: opts.fetch, maxRetries: 2 });
  }

  supports(capability: EngineCapability): boolean {
    return this.opts.capabilities.includes(capability);
  }

  async estimateUsage(request: AgentRequest) {
    return { inputTokens: roughTokens(request), approxCostUsd: null };
  }

  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    const tools: OpenAI.Responses.FunctionTool[] = request.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      // Strict schemas need every property required; ours have optionals, and
      // every input is validated before it runs anyway.
      strict: false,
    }));
    const byName = new Map(request.tools.map((t) => [t.name, t]));

    const input: OpenAI.Responses.ResponseInputItem[] = request.history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const maxRounds = request.maxToolRounds ?? 8;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let round = 0; ; round++) {
      let completed: OpenAI.Responses.Response | null = null;
      try {
        const stream = await this.client.responses.create(
          {
            model: this.model,
            instructions: request.system,
            input,
            ...(tools.length ? { tools } : {}),
            store: this.opts.store,
            stream: true,
          },
          { signal: request.signal },
        );
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            yield { type: "text", text: event.delta };
          } else if (event.type === "response.completed" || event.type === "response.incomplete") {
            completed = event.response;
          } else if (event.type === "response.failed") {
            throw new EngineError(
              `OpenAI could not finish the answer${event.response.error ? `: ${event.response.error.message}` : "."}`,
              true,
            );
          } else if (event.type === "error") {
            throw new EngineError(`OpenAI returned an error: ${event.message}`, true);
          }
        }
      } catch (err) {
        throw classify(err);
      }
      if (!completed) throw new EngineError("OpenAI ended the answer without finishing it.", true);

      inputTokens += completed.usage?.input_tokens ?? 0;
      outputTokens += completed.usage?.output_tokens ?? 0;
      if (completed.status === "incomplete") {
        yield { type: "notice", level: "warning", message: "The answer was cut short before it finished." };
      }

      const calls = completed.output.filter(
        (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call",
      );
      if (calls.length === 0) break;
      if (round >= maxRounds) {
        yield {
          type: "notice",
          level: "warning",
          message: `Stopped after ${maxRounds} rounds of looking things up. Ask a narrower question to go further.`,
        };
        break;
      }

      for (const item of completed.output) {
        if (item.type === "message" || item.type === "function_call") {
          input.push(item as OpenAI.Responses.ResponseInputItem);
        }
      }

      for (const call of calls) {
        let raw: unknown;
        try {
          raw = JSON.parse(call.arguments || "{}");
        } catch {
          raw = undefined;
        }
        yield { type: "tool_start", id: call.call_id, name: call.name, input: raw };
        const tool = byName.get(call.name);
        const parsed = tool ? tool.parse(raw) : ({ ok: false, error: `No tool named ${call.name}.` } as const);
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
        input.push({ type: "function_call_output", call_id: call.call_id, output });
        yield {
          type: "tool_end",
          id: call.call_id,
          name: call.name,
          ok,
          summary: output.length > 160 ? `${output.slice(0, 157)}…` : output,
        };
      }
    }

    yield { type: "usage", inputTokens, outputTokens };
  }
}

function classify(err: unknown): Error {
  if (err instanceof EngineError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new EngineError("The OpenAI API key was refused. Check OPENAI_API_KEY.", false);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new EngineError("OpenAI is rate-limited or out of credit right now.", true);
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new EngineError(`OpenAI could not take that request: ${err.message}`, false);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new EngineError("OpenAI could not be reached.", true);
  }
  if (err instanceof OpenAI.APIError) {
    return new EngineError(`OpenAI returned an error (${err.status ?? "unknown"}).`, true);
  }
  return err instanceof Error ? err : new Error(String(err));
}
