"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireChatBossAction } from "@/lib/auth/authorize";
import { getJobByRef } from "@/lib/db";
import {
  addContextItem,
  archiveConversation,
  createConversation,
  getConversation,
  removeContextItem,
  updateConversation,
  withheldEngineModes,
} from "@/lib/db/workspace";
import { defaultMode, modeOptions } from "@/lib/ai/engine/registry";
import {
  AlreadyLinkedError,
  getLinkedRepository,
  linkRepository,
  listLinkedRepositories,
  type RepositoryRow,
  setConversationRepository,
  unlinkRepository,
} from "@/lib/db/repositories";
import { githubApp, readerFor } from "@/lib/repo";
import { checkBranch, checkPath } from "@/lib/repo/policy";
import { RepoError } from "@/lib/repo/types";
import { workspaceAccess } from "@/lib/workspace/access";
import { bindRepository } from "@/lib/workspace/bind";
import { contextRef } from "@/lib/workspace/repo-tools";

/**
 * Chat Boss's writes. Each one passes the central authorization function for
 * the business the session has open (Origin, CSRF, membership, role) and the
 * Chat Boss list; nothing in a form names a business or a person. A conversation id from a form is checked by the database against
 * both, so an id copied from another client's screen changes nothing.
 */

async function requireAccess(formData: FormData) {
  const { ctx } = await requireChatBossAction(formData);
  const access = await workspaceAccess(ctx);
  if (!access) redirect("/dashboard");
  return access;
}

const id = z.uuid();

export async function newConversationAction(formData: FormData) {
  const access = await requireAccess(formData);
  const options = modeOptions(await withheldEngineModes(access.owner));
  const conversation = await createConversation(access.owner, {
    title: "New conversation",
    mode: "ask",
    engineMode: defaultMode(options) ?? "claude-coding",
  });
  redirect(`/chat?c=${conversation.id}`);
}

/**
 * The same, from the Chat Boss panel beside another page: the conversation is
 * started and the person stays where they are. The panel always shows the
 * most recent conversation, which is now this one.
 */
export async function newDockConversationAction(formData: FormData) {
  const access = await requireAccess(formData);
  const options = modeOptions(await withheldEngineModes(access.owner));
  await createConversation(access.owner, {
    title: "New conversation",
    mode: "ask",
    engineMode: defaultMode(options) ?? "claude-coding",
  });
  revalidatePath("/", "layout");
}

export async function setModeAction(formData: FormData) {
  const access = await requireAccess(formData);
  const conversationId = id.parse(formData.get("conversationId"));
  // Build is not an option here: the database refuses it as well.
  const mode = z.enum(["ask", "plan"]).parse(formData.get("mode"));
  await updateConversation(access.owner, conversationId, { mode });
  revalidatePath("/chat");
}

export async function setEngineAction(formData: FormData) {
  const access = await requireAccess(formData);
  const conversationId = id.parse(formData.get("conversationId"));
  const engineMode = String(formData.get("engineMode") ?? "");
  const option = modeOptions(await withheldEngineModes(access.owner)).find((o) => o.id === engineMode);
  if (!option?.available) redirect(`/chat?c=${conversationId}&error=engine`);
  await updateConversation(access.owner, conversationId, { engineMode });
  revalidatePath("/chat");
}

export async function addJobContextAction(formData: FormData) {
  const access = await requireAccess(formData);
  const conversationId = id.parse(formData.get("conversationId"));
  const ref = String(formData.get("ref") ?? "").trim();
  if (!(await getConversation(access.owner, conversationId))) redirect("/chat");
  // Through the workspace's scope: another client's reference finds nothing.
  const job = /^[A-Za-z0-9]{2,8}-\d{1,6}$/.test(ref) ? await getJobByRef(access.scope, ref) : null;
  if (!job) redirect(`/chat?c=${conversationId}&error=job`);
  await addContextItem(access.owner, conversationId, { kind: "job", ref: job.id });
  revalidatePath("/chat");
}

export async function removeContextAction(formData: FormData) {
  const access = await requireAccess(formData);
  const conversationId = id.parse(formData.get("conversationId"));
  const itemId = id.parse(formData.get("itemId"));
  await removeContextItem(access.owner, conversationId, itemId);
  revalidatePath("/chat");
}

export async function archiveConversationAction(formData: FormData) {
  const access = await requireAccess(formData);
  const conversationId = id.parse(formData.get("conversationId"));
  await archiveConversation(access.owner, conversationId);
  redirect("/chat");
}

/**
 * Link a repository the GitHub App can see to the client in scope. The form
 * names GitHub's repository id only; installation, owner and name are taken
 * from GitHub's own answer, never from the form.
 */
export async function linkRepositoryAction(formData: FormData) {
  const access = await requireAccess(formData);
  const back = backTo(formData);
  const externalId = Number(formData.get("externalId"));
  const app = githubApp();
  if (!app || !Number.isSafeInteger(externalId) || externalId <= 0) redirect(`${back}&error=repo`);
  let found;
  try {
    found = (await app.listAccessibleRepositories()).find((r) => r.externalId === externalId);
  } catch (err) {
    if (!(err instanceof RepoError)) throw err;
  }
  if (!found) redirect(`${back}&error=repo`);
  try {
    await linkRepository(access.owner, found);
  } catch (err) {
    if (err instanceof AlreadyLinkedError) redirect(`${back}&error=linked`);
    throw err;
  }
  revalidatePath("/chat");
  redirect(back);
}

export async function unlinkRepositoryAction(formData: FormData) {
  const access = await requireAccess(formData);
  await unlinkRepository(access.owner, id.parse(formData.get("repositoryId")));
  revalidatePath("/chat");
  redirect(backTo(formData));
}

/** Point the conversation at a linked repository and one of its branches, or at none. */
export async function setRepositoryAction(formData: FormData) {
  const access = await requireAccess(formData);
  const conversationId = id.parse(formData.get("conversationId"));
  const back = `/chat?c=${conversationId}`;
  const repositoryId = String(formData.get("repositoryId") ?? "");
  if (!repositoryId) {
    await setConversationRepository(access.owner, conversationId, null, null);
    revalidatePath("/chat");
    return;
  }
  const row = await getLinkedRepository(access.owner, repositoryId);
  if (!row) redirect(`${back}&error=repo`);
  const branch = await branchFor(row, String(formData.get("branch") ?? ""));
  if (!branch) redirect(`${back}&error=branch`);
  await setConversationRepository(access.owner, conversationId, row.id, branch);
  revalidatePath("/chat");
}

/**
 * The branch asked for, or the repository's default; null when it is not a
 * branch name, or does not exist now (a typo would otherwise fail on the next
 * message).
 */
async function branchFor(row: RepositoryRow, requested: string): Promise<string | null> {
  const checked = checkBranch(requested || row.defaultBranch);
  if (!checked.ok) return null;
  const reader = readerFor(row);
  if (reader && checked.branch !== row.defaultBranch) {
    const branches = await reader.listBranches().catch(() => [] as string[]);
    if (!branches.includes(checked.branch)) return null;
  }
  return checked.branch;
}

export type PanelRepositoryResult = { ok: true } | { ok: false; error: string };

/**
 * The Chat Boss panel's "+ GitHub repository": put a repository on the
 * conversation without leaving the page, the way Claude Code adds one to a
 * session. One step, whichever the person picked:
 *
 *   - a repository already linked to this business (`repositoryId`), or
 *   - one the GitHub App can see but nobody has linked yet (`externalId`),
 *     which is linked to this business first, exactly as the workspace's
 *     "Link" does: installation, owner and name come from GitHub's answer.
 *
 * Neither names a branch and the default is used, unless `branch` asks for
 * another. With neither, the conversation is taken off its repository.
 *
 * It answers instead of redirecting, so the panel stays on the page it is
 * beside and says what went wrong in place.
 */
export async function panelRepositoryAction(formData: FormData): Promise<PanelRepositoryResult> {
  const access = await requireAccess(formData);
  const conversationId = id.safeParse(formData.get("conversationId"));
  if (!conversationId.success) return { ok: false, error: "That conversation does not exist here." };

  const repositoryId = String(formData.get("repositoryId") ?? "");
  const externalId = Number(formData.get("externalId") ?? 0);
  let row: RepositoryRow | null = null;

  if (repositoryId) {
    row = await getLinkedRepository(access.owner, repositoryId);
  } else if (externalId) {
    const app = githubApp();
    if (!app) return { ok: false, error: "The GitHub App is not set up on this server." };
    if (!Number.isSafeInteger(externalId) || externalId <= 0) return { ok: false, error: NOT_AVAILABLE };
    // Picked from a list fetched a moment ago: it may have been linked since.
    row = (await listLinkedRepositories(access.owner)).find((r) => r.externalId === externalId) ?? null;
    if (!row) {
      let found;
      try {
        found = (await app.listAccessibleRepositories()).find((r) => r.externalId === externalId);
      } catch (err) {
        if (!(err instanceof RepoError)) throw err;
        return { ok: false, error: "GitHub could not be reached. Try again in a moment." };
      }
      if (!found) return { ok: false, error: NOT_AVAILABLE };
      try {
        row = await linkRepository(access.owner, found);
      } catch (err) {
        if (err instanceof AlreadyLinkedError) {
          return { ok: false, error: "That repository is already linked to another business. Unlink it there first." };
        }
        throw err;
      }
    }
  } else {
    if (!(await setConversationRepository(access.owner, conversationId.data, null, null))) {
      return { ok: false, error: "That conversation does not exist here." };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  }

  if (!row) return { ok: false, error: NOT_AVAILABLE };
  const branch = await branchFor(row, String(formData.get("branch") ?? ""));
  if (!branch) return { ok: false, error: "That branch does not exist in the repository." };
  if (!(await setConversationRepository(access.owner, conversationId.data, row.id, branch))) {
    return { ok: false, error: "That conversation does not exist here." };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

const NOT_AVAILABLE = "That repository is not available. Check the GitHub App can see it.";

/** Add a file or folder of the conversation's repository to its context. */
export async function addRepoContextAction(formData: FormData) {
  const access = await requireAccess(formData);
  const conversationId = id.parse(formData.get("conversationId"));
  const back = `/chat?c=${conversationId}`;
  const kind = z.enum(["file", "folder"]).parse(formData.get("kind"));
  const checked = checkPath(formData.get("path"));
  if (!checked.ok) redirect(`${back}&error=path`);
  const conversation = await getConversation(access.owner, conversationId);
  if (!conversation) redirect("/chat");
  const binding = await bindRepository(access.owner, conversation);
  if ("error" in binding || !binding.bound) redirect(`${back}&error=repo`);
  const { bound } = binding;
  try {
    if (kind === "file") await bound.reader.readFile(bound.snap, checked.path, { start: 1, end: 1 });
    else await bound.reader.listDirectory(bound.snap, checked.path);
  } catch (err) {
    if (err instanceof RepoError) redirect(`${back}&error=path`);
    throw err;
  }
  await addContextItem(access.owner, conversationId, { kind, ref: contextRef(bound.row.id, checked.path) });
  revalidatePath("/chat");
}

function backTo(formData: FormData) {
  const c = formData.get("conversationId");
  return typeof c === "string" && id.safeParse(c).success ? `/chat?c=${c}` : "/chat?";
}
