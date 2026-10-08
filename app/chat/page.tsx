import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireChatBossPage } from "@/lib/auth/authorize";
import { openableBusinesses } from "@/lib/auth/policy";
import { resolveIdentity } from "@/lib/auth/session";
import { getJob } from "@/lib/db";
import {
  getConversation,
  listContextItems,
  listConversations,
  listMessages,
  listRuns,
  withheldEngineModes,
} from "@/lib/db/workspace";
import { findMode, modeOptions } from "@/lib/ai/engine/registry";
import { listLinkedRepositories, repositoryNamesByIds } from "@/lib/db/repositories";
import { githubConfigured } from "@/lib/repo";
import { workspaceAccess } from "@/lib/workspace/access";
import { parseContextRef } from "@/lib/workspace/repo-tools";
import { PortalShell } from "../portal-shell";
import type { WorkspaceData } from "./types";
import { Workspace } from "./workspace";

export const metadata: Metadata = { title: "Workspace" };

const ERRORS: Record<string, string> = {
  reason: "Give a reason of at least eight characters to open a client. It goes in the audit record.",
  unknown: "That client no longer exists.",
  engine: "That engine is not available for this client.",
  job: "No job with that reference exists for this client.",
  repo: "That repository is not available. Check the GitHub App can see it and that it is linked to this client.",
  linked: "That repository is already linked to another client. Unlink it there first.",
  branch: "That branch does not exist in the repository.",
  path: "That path cannot be added: it does not exist, or it is a secret or binary file.",
};

/**
 * The workspace: one client, its conversations, and what every answer saw.
 *
 * Chat Boss, for the people on its list (lib/auth/chat-boss.ts), on the
 * business their session has open and only one they belong to. The
 * conversation is in the URL, so a refresh lands back on it —
 * and the database checks that it belongs to this client and this person.
 */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; error?: string }>;
}) {
  const { ctx } = await requireChatBossPage("/chat");
  const access = await workspaceAccess(ctx);
  const identity = await resolveIdentity();
  const csrf = identity.state === "active" ? identity.csrfToken : "";
  if (!access) redirect("/dashboard");

  const params = await searchParams;
  const conversations = await listConversations(access.owner);

  // No conversation named: open the most recent rather than an empty page.
  if (!params.c && conversations[0]) redirect(`/chat?c=${conversations[0].id}`);

  const conversation = params.c ? await getConversation(access.owner, params.c) : null;
  // Named but not ours — another client's, another person's, or archived.
  if (params.c && !conversation) redirect("/chat");

  const [messages, runs, contextItems, withheld, linked] = await Promise.all([
    conversation ? listMessages(access.owner, conversation.id) : [],
    conversation ? listRuns(access.owner, conversation.id) : [],
    conversation ? listContextItems(access.owner, conversation.id) : [],
    withheldEngineModes(access.owner),
    listLinkedRepositories(access.owner),
  ]);
  const repoNames = await repositoryNamesByIds(
    access.owner,
    runs.flatMap((r) => (r.repositoryId ? [r.repositoryId] : [])),
  );
  const currentRepo = conversation?.repositoryId ? linked.find((r) => r.id === conversation.repositoryId) : undefined;

  const context = await Promise.all(
    contextItems.map(async (item) => {
      if (item.kind !== "job") {
        const parsed = parseContextRef(item.ref);
        const here = parsed && parsed.repositoryId === currentRepo?.id;
        const label = parsed ? `${parsed.path || "/"}${item.kind === "folder" ? " (folder)" : ""}` : "No longer available";
        return { id: item.id, kind: item.kind, label: here ? label : `${label} — another repository, not sent`, path: here ? parsed.path : null };
      }
      const job = await getJob(access.scope, item.ref);
      return { id: item.id, kind: item.kind, label: job ? `${job.ref} — ${job.title}` : "No longer available", path: null };
    }),
  );

  const data: WorkspaceData = {
    client: access.client,
    // Your own businesses: switching between them is the business switcher's.
    clients: openableBusinesses(ctx.memberships, ctx.agencyAccess).map((b) => ({
      id: b.organizationId,
      name: b.organizationName,
    })),
    csrf,
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
      engineLabel: findMode(r.engineMode)?.label ?? r.engineMode,
      provider: r.provider,
      model: r.model,
      mode: r.mode,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      startedAt: r.startedAt.toISOString(),
      repository:
        r.repositoryId && r.branch && r.commitSha
          ? { name: repoNames.get(r.repositoryId) ?? "unknown", branch: r.branch, commitSha: r.commitSha }
          : null,
      receipts: r.receipts.map((x) => ({
        kind: x.kind,
        label: x.label,
        ref: x.ref,
        sentToProvider: x.sentToProvider,
        detail: x.detail as Record<string, unknown> | null,
      })),
    })),
    context,
    repository: {
      configured: githubConfigured(),
      linked: linked.map((r) => ({ id: r.id, name: `${r.owner}/${r.name}`, defaultBranch: r.defaultBranch })),
      current: currentRepo
        ? {
            id: currentRepo.id,
            name: `${currentRepo.owner}/${currentRepo.name}`,
            branch: conversation?.branch ?? currentRepo.defaultBranch,
            defaultBranch: currentRepo.defaultBranch,
          }
        : null,
    },
    engines: modeOptions(withheld, conversation?.engineMode),
    error: params.error ? (ERRORS[params.error] ?? "That did not work.") : null,
  };

  return (
    <PortalShell
      email={ctx.email}
      isStaff={false}
      wide
      chatPanel={false}
      actingOn={null}
    >
      <Workspace data={data} />
    </PortalShell>
  );
}
