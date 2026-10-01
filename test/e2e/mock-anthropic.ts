import { createServer, type Server } from "node:http";

/**
 * A stand-in for the Anthropic API, for the workspace's browser tests.
 *
 * The dev server is pointed at it with ANTHROPIC_BASE_URL, so everything else
 * is real: the Claude SDK builds a real request, the portal runs its real job
 * tools against the real database, and the receipts are real rows. Only the
 * model's side of the conversation is scripted:
 *
 *   - a question naming a job reference (ROT-0001) gets a read_job tool call;
 *   - once a tool result comes back, an answer citing that reference;
 *   - anything else, a plain answer.
 */

export const MOCK_ANTHROPIC_PORT = 4010;
export const MOCK_ANTHROPIC_URL = `http://127.0.0.1:${MOCK_ANTHROPIC_PORT}`;

type Body = { messages: { role: string; content: unknown }[] };

function events(blocks: ({ text: string } | { tool: string; input: unknown })[], stop: string) {
  const out: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
    ],
  ];
  blocks.forEach((b, index) => {
    if ("text" in b) {
      out.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      out.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }]);
    } else {
      out.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `tu_${index}`, name: b.tool, input: {} } }]);
      out.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    out.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  out.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } }]);
  out.push(["message_stop", { type: "message_stop" }]);
  return out.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

export function startMockAnthropic(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Body;
      const last = body.messages?.at(-1);
      const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      const ref = /[A-Z]{3}-\d{4}/.exec(lastText)?.[0];
      const isToolResult = Array.isArray(last?.content) && JSON.stringify(last.content).includes("tool_result");

      let payload: string;
      if (isToolResult) {
        const seen = /([A-Z]{3}-\d{4})/.exec(JSON.stringify(last!.content))?.[1] ?? "the job";
        payload = events([{ text: `That job is on record [JOB ${seen}].` }], "end_turn");
      } else if (ref) {
        payload = events([{ tool: "read_job", input: { ref } }], "tool_use");
      } else {
        payload = events([{ text: "A plain answer." }], "end_turn");
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(MOCK_ANTHROPIC_PORT, "127.0.0.1", () => resolve(server)));
}
