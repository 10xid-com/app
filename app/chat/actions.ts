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
  type RepositoryRow,
  setConversationRepository,
  unlinkRepository,
} from "@/lib/db/repositories";
import { githubApp, readerFor } from "@/lib/repo";
import { checkBranch, checkPath } from "@/lib/repo/policy";
import { RepoError } from "@/lib/repo/types";
import { workspaceAccess } from "@/lib/workspace/access";
import { websiteFor } from "@/lib/db/sites";
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
 * The Chat Boss panel's "+ GitHub repository": put the business's WEBSITE
 * repository on the conversation without leaving the page — the repository
 * the Website channel is connected with, and no other. The panel lists only
 * that one, and this checks it again: a repository id from anywhere else is
 * refused, even one linked to the business (the workspace's own picker is
 * where any of those is chosen).
 *
 * `branch` changes the branch; without it the default is used. With no
 * `repositoryId` the conversation is taken off its repository.
 *
 * It answers instead of redirecting, so the panel stays on the page it is
 * beside and says what went wrong in place.
 */
export async function panelRepositoryAction(formData: FormData): Promise<PanelRepositoryResult> {
  const access = await requireAccess(formData);
  const conversationId = id.safeParse(formData.get("conversationId"));
  if (!conversationId.success || !(await getConversation(access.owner, conversationId.data))) {
    return { ok: false, error: "That conversation does not exist here." };
  }

  const repositoryId = String(formData.get("repositoryId") ?? "");
  if (!repositoryId) {
    await setConversationRepository(access.owner, conversationId.data, null, null);
    revalidatePath("/", "layout");
    return { ok: true };
  }

  const site = await websiteFor(access.owner);
  if (!site?.repositoryId || site.repositoryId !== repositoryId) {
    return { ok: false, error: "Only the website’s repository can be added here." };
  }
  const row = await getLinkedRepository(access.owner, repositoryId);
  if (!row) return { ok: false, error: "The website’s repository is no longer linked to this business." };
  const branch = await branchFor(row, String(formData.get("branch") ?? ""));
  if (!branch) return { ok: false, error: "That branch does not exist in the repository." };
  if (!(await setConversationRepository(access.owner, conversationId.data, row.id, branch))) {
    return { ok: false, error: "That conversation does not exist here." };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

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
