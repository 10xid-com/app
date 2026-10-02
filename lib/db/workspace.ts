import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { inOwnerTransaction } from "./connection";
import {
  agentRunReceipts,
  agentRuns,
  conversationContextItems,
  conversationMessages,
  conversations,
  engineModePolicies,
  workspaces,
} from "./schema";
import { uuidv7 } from "../ids";

/**
 * The workspace's data, every function scoped to one client AND one person.
 *
 * There is no unscoped variant here, for the same reason lib/db/index.ts has
 * none: the first argument is always the owner, and the database filters by
 * it again underneath (0018). A conversation id from another client or another
 * person reads as nothing — not found and not yours are the same answer.
 */

export type WorkspaceOwner = {
  /** The client the work is for: a grant's client, or the house when none. */
  organizationId: string;
  /** The staff member the conversation belongs to. */
  userId: string;
};

export type ConversationMode = "ask" | "plan";
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof conversationMessages.$inferSelect;
export type RunRow = typeof agentRuns.$inferSelect;
export type ReceiptRow = typeof agentRunReceipts.$inferSelect;
export type ContextItemRow = typeof conversationContextItems.$inferSelect;

/** The commands the composer offers. Data, never a hidden prompt. */
export const COMMANDS = ["review", "explain", "plan", "test"] as const;
export type Command = (typeof COMMANDS)[number];

const run = <T>(owner: WorkspaceOwner, fn: Parameters<typeof inOwnerTransaction<T>>[2]) =>
  inOwnerTransaction(owner.organizationId, owner.userId, fn);

/**
 * The client's live workspace, created on first use.
 *
 * Two staff opening the same client at the same moment both try to insert;
 * the partial unique index lets exactly one win and the other reads it back.
 */
export async function ensureWorkspace(owner: WorkspaceOwner) {
  return run(owner, async (tx) => {
    await tx
      .insert(workspaces)
      .values({ id: uuidv7(), organizationId: owner.organizationId, createdBy: owner.userId })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.organizationId, owner.organizationId), isNull(workspaces.archivedAt)))
      .limit(1);
    if (!row) throw new Error("The workspace could not be created.");
    return row;
  });
}

export async function listConversations(owner: WorkspaceOwner, limit = 50) {
  return run(owner, (tx) =>
    tx
      .select({
        id: conversations.id,
        title: conversations.title,
        mode: conversations.mode,
        engineMode: conversations.engineMode,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(isNull(conversations.archivedAt))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit),
  );
}

export async function createConversation(
  owner: WorkspaceOwner,
  input: { title: string; mode: ConversationMode; engineMode: string },
): Promise<ConversationRow> {
  const workspace = await ensureWorkspace(owner);
  return run(owner, async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({
        id: uuidv7(),
        workspaceId: workspace.id,
        organizationId: owner.organizationId,
        createdBy: owner.userId,
        title: input.title.trim().slice(0, 200) || "New conversation",
        mode: input.mode,
        engineMode: input.engineMode,
      })
      .returning();
    return row!;
  });
}

export async function getConversation(
  owner: WorkspaceOwner,
  id: string,
): Promise<ConversationRow | null> {
  if (!isUuid(id)) return null;
  const rows = await run(owner, (tx) =>
    tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.archivedAt)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** Mode, engine and title are the settings a conversation carries forward. */
export async function updateConversation(
  owner: WorkspaceOwner,
  id: string,
  patch: Partial<{ mode: ConversationMode; engineMode: string; title: string }>,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await run(owner, (tx) =>
    tx
      .update(conversations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id }),
  );
  return rows.length === 1;
}

export async function archiveConversation(owner: WorkspaceOwner, id: string) {
  if (!isUuid(id)) return false;
  const rows = await run(owner, (tx) =>
    tx
      .update(conversations)
      .set({ archivedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id }),
  );
  return rows.length === 1;
}

export async function listMessages(owner: WorkspaceOwner, conversationId: string) {
  return run(owner, (tx) =>
    tx
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id)),
  );
}

export async function appendUserMessage(
  owner: WorkspaceOwner,
  conversationId: string,
  content: string,
  command: Command | null,
): Promise<MessageRow> {
  return run(owner, async (tx) => {
    const [row] = await tx
      .insert(conversationMessages)
      .values({
        id: uuidv7(),
        conversationId,
        organizationId: owner.organizationId,
        createdBy: owner.userId,
        role: "user",
        content,
        command,
      })
      .returning();
    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    return row!;
  });
}

export async function startRun(
  owner: WorkspaceOwner,
  input: {
    conversationId: string;
    userMessageId: string;
    mode: ConversationMode;
    engineMode: string;
    provider: string;
    model: string;
    repositoryId?: string | null;
    branch?: string | null;
    commitSha?: string | null;
  },
): Promise<RunRow> {
  return run(owner, async (tx) => {
    const [row] = await tx
      .insert(agentRuns)
      .values({
        id: uuidv7(),
        organizationId: owner.organizationId,
        createdBy: owner.userId,
        ...input,
      })
      .returning();
    return row!;
  });
}

export type NewReceipt = {
  kind: ReceiptRow["kind"];
  label: string;
  ref?: string | null;
  detail?: Record<string, unknown>;
  sentToProvider: boolean;
};

export async function addReceipts(owner: WorkspaceOwner, runId: string, receipts: NewReceipt[]) {
  if (receipts.length === 0) return;
  await run(owner, (tx) =>
    tx.insert(agentRunReceipts).values(
      receipts.map((r) => ({
        runId,
        organizationId: owner.organizationId,
        createdBy: owner.userId,
        kind: r.kind,
        label: r.label.slice(0, 500),
        ref: r.ref ?? null,
        detail: r.detail ?? {},
        sentToProvider: r.sentToProvider,
      })),
    ),
  );
}

/**
 * Close a run and record what it said, in one transaction, so a run marked
 * completed always has its answer beside it.
 */
export async function finishRun(
  owner: WorkspaceOwner,
  input: {
    runId: string;
    conversationId: string;
    status: "completed" | "failed" | "cancelled";
    error?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    answer: string;
  },
): Promise<MessageRow | null> {
  return run(owner, async (tx) => {
    await tx
      .update(agentRuns)
      .set({
        status: input.status,
        error: input.error ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, input.runId));

    let message: MessageRow | null = null;
    if (input.answer.length > 0) {
      [message] = await tx
        .insert(conversationMessages)
        .values({
          id: uuidv7(),
          conversationId: input.conversationId,
          organizationId: owner.organizationId,
          createdBy: owner.userId,
          role: "assistant",
          content: input.answer,
          runId: input.runId,
          status: input.status === "completed" ? "complete" : input.status === "failed" ? "failed" : "cut_off",
        })
        .returning();
    }
    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));
    return message;
  });
}

/** Every run in a conversation with its receipts, oldest first. */
export async function listRuns(owner: WorkspaceOwner, conversationId: string) {
  return run(owner, async (tx) => {
    const runs = await tx
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.conversationId, conversationId))
      .orderBy(asc(agentRuns.startedAt));
    const receipts = runs.length
      ? await tx
          .select()
          .from(agentRunReceipts)
          .where(inArray(agentRunReceipts.runId, runs.map((r) => r.id)))
          .orderBy(asc(agentRunReceipts.id))
      : [];
    return runs.map((r) => ({ ...r, receipts: receipts.filter((x) => x.runId === r.id) }));
  });
}

export async function listContextItems(owner: WorkspaceOwner, conversationId: string) {
  return run(owner, (tx) =>
    tx
      .select()
      .from(conversationContextItems)
      .where(
        and(
          eq(conversationContextItems.conversationId, conversationId),
          isNull(conversationContextItems.removedAt),
        ),
      )
      .orderBy(asc(conversationContextItems.addedAt)),
  );
}

export async function addContextItem(
  owner: WorkspaceOwner,
  conversationId: string,
  item: { kind: ContextItemRow["kind"]; ref: string },
) {
  await run(owner, (tx) =>
    tx
      .insert(conversationContextItems)
      .values({
        id: uuidv7(),
        conversationId,
        organizationId: owner.organizationId,
        createdBy: owner.userId,
        kind: item.kind,
        ref: item.ref,
      })
      .onConflictDoNothing(),
  );
}

export async function removeContextItem(owner: WorkspaceOwner, conversationId: string, itemId: string) {
  if (!isUuid(itemId)) return;
  await run(owner, (tx) =>
    tx
      .update(conversationContextItems)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(conversationContextItems.id, itemId),
          eq(conversationContextItems.conversationId, conversationId),
        ),
      ),
  );
}

/** Engine modes this client's work may not be sent to. */
export async function withheldEngineModes(owner: WorkspaceOwner): Promise<Set<string>> {
  const rows = await run(owner, (tx) =>
    tx
      .select({ engineMode: engineModePolicies.engineMode })
      .from(engineModePolicies)
      .where(sql`${engineModePolicies.allowed} = false`),
  );
  return new Set(rows.map((r) => r.engineMode));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
