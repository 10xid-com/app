/**
 * The workspace's data as the browser receives it: plain, serialisable, and
 * containing nothing the person could not already see.
 */
import type { EngineModeOption } from "@/lib/ai/engine/modes";
import type { WireReceipt } from "@/lib/workspace/wire";

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  command: string | null;
  runId: string | null;
  status: string;
  createdAt: string;
};

export type UiRun = {
  id: string;
  userMessageId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  error: string | null;
  engineMode: string;
  engineLabel: string;
  provider: string;
  model: string;
  mode: string;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string;
  receipts: WireReceipt[];
};

export type UiConversation = {
  id: string;
  title: string;
  mode: "ask" | "plan";
  engineMode: string;
};

export type UiContextItem = { id: string; kind: string; label: string };

export type WorkspaceData = {
  client: { id: string; name: string; isHouse: boolean };
  grant: { reason: string; expiresAt: string } | null;
  clients: { id: string; name: string }[];
  conversations: { id: string; title: string; mode: string; updatedAt: string }[];
  conversation: UiConversation | null;
  messages: UiMessage[];
  runs: UiRun[];
  context: UiContextItem[];
  engines: EngineModeOption[];
  error: string | null;
};
