/**
 * What the workspace's streaming endpoint sends to the browser, one JSON
 * object per line. Client-safe: types only.
 */

export type WireReceipt = {
  kind: "file" | "folder" | "job" | "attachment" | "tool_call" | "warning";
  label: string;
  ref: string | null;
  sentToProvider: boolean;
  /** Patch previews carry their diff here; other receipts may carry the commit read. */
  detail?: Record<string, unknown> | null;
};

export type WireEvent =
  | {
      type: "run";
      runId: string;
      userMessageId: string;
      engineMode: string;
      engineLabel: string;
      provider: string;
      model: string;
      mode: "ask" | "plan";
      command: string | null;
      client: { id: string; name: string; isHouse: boolean };
      repository: { id: string; name: string; branch: string; commitSha: string } | null;
    }
  | { type: "text"; text: string }
  | { type: "model"; model: string }
  | { type: "tool"; phase: "start" | "end"; id: string; name: string; ok?: boolean; summary?: string }
  | { type: "receipt"; receipt: WireReceipt }
  | { type: "notice"; level: "info" | "warning"; message: string }
  | {
      type: "done";
      status: "completed" | "failed" | "cancelled";
      messageId: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  /** Nothing was sent to any model: the request was refused before starting. */
  | { type: "error"; message: string };
