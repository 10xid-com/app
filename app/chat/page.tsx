import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/require";
import { getJob } from "@/lib/db";
import { listClientOrganizations, liveGrantForSession } from "@/lib/db/identity";
import {
  getConversation,
  listContextItems,
  listConversations,
  listMessages,
  listRuns,
  withheldEngineModes,
} from "@/lib/db/workspace";
import { modeSpec } from "@/lib/ai/engine/modes";
import { modeOptions } from "@/lib/ai/engine/registry";
import { workspaceAccess } from "@/lib/workspace/access";
import { PortalShell } from "../portal-shell";
import type { WorkspaceData } from "./types";
import { Workspace } from "./workspace";

export const metadata: Metadata = { title: "Workspace" };

const ERRORS: Record<string, string> = {
  reason: "Give a reason of at least eight characters to open a client. It goes in the audit record.",
  unknown: "That client no longer exists.",
  engine: "That engine is not available for this client.",
  job: "No job with that reference exists for this client.",
};

/**
 * The workspace: one client, its conversations, and what every answer saw.
 *
 * Staff only, as themselves. The client is the session's live grant (opened
 * here with a reason, exactly as on the Clients page), or the house when none
 * is held. The conversation is in the URL, so a refresh lands back on it —
 * and the database checks that it belongs to this client and this person.
 */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; error?: string }>;
}) {
  const ctx = await requireSession("/chat");
  const access = await workspaceAccess(ctx);
  if (!access) redirect("/dashboard");

  const params = await searchParams;
  const conversations = await listConversations(access.owner);

  // No conversation named: open the most recent rather than an empty page.
  if (!params.c && conversations[0]) redirect(`/chat?c=${conversations[0].id}`);

  const conversation = params.c ? await getConversation(access.owner, params.c) : null;
  // Named but not ours — another client's, another person's, or archived.
  if (params.c && !conversation) redirect("/chat");

  const [messages, runs, contextItems, withheld, clients, grant] = await Promise.all([
    conversation ? listMessages(access.owner, conversation.id) : [],
    conversation ? listRuns(access.owner, conversation.id) : [],
    conversation ? listContextItems(access.owner, conversation.id) : [],
    withheldEngineModes(access.owner),
    listClientOrganizations(),
    liveGrantForSession(ctx.sessionId),
  ]);

  const context = await Promise.all(
    contextItems.map(async (item) => {
      const job = item.kind === "job" ? await getJob(access.scope, item.ref) : null;
      return { id: item.id, kind: item.kind, label: job ? `${job.ref} — ${job.title}` : "No longer available" };
    }),
  );

  const data: WorkspaceData = {
    client: access.client,
    grant: grant ? { reason: grant.reason, expiresAt: grant.expiresAt.toISOString() } : null,
    clients: clients.map((c) => ({ id: c.id, name: c.name })),
    conversations: conversations.map((c) => ({ ...c, updatedAt: c.updatedAt.toISOString() })),
    conversation: conversation
      ? {
          id: conversation.id,
          title: conversation.title,
          mode: conversation.mode === "plan" ? "plan" : "ask",
          engineMode: conversation.engineMode,
        }
      : null,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      command: m.command,
      runId: m.runId,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    })),
    runs: runs.map((r) => ({
      id: r.id,
      userMessageId: r.userMessageId,
      status: r.status,
      error: r.error,
      engineMode: r.engineMode,
      engineLabel: modeSpec(r.engineMode)?.label ?? r.engineMode,
      provider: r.provider,
      model: r.model,
      mode: r.mode,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      startedAt: r.startedAt.toISOString(),
      receipts: r.receipts.map((x) => ({ kind: x.kind, label: x.label, ref: x.ref, sentToProvider: x.sentToProvider })),
    })),
    context,
    engines: modeOptions(withheld),
    error: params.error ? (ERRORS[params.error] ?? "That did not work.") : null,
  };

  return (
    <PortalShell
      email={ctx.email}
      isStaff
      wide
      actingOn={!access.client.isHouse && grant ? { name: access.client.name, reason: grant.reason } : null}
    >
      <Workspace data={data} />
    </PortalShell>
  );
}
