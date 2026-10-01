"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth/session";
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
import { workspaceAccess } from "@/lib/workspace/access";

/**
 * The workspace's writes. Each one re-derives who is asking from the session
 * and the client from the live grant; nothing in a form names a client or a
 * person. A conversation id from a form is checked by the database against
 * both, so an id copied from another client's screen changes nothing.
 */

async function requireAccess() {
  const access = await workspaceAccess(await getSessionContext());
  if (!access) redirect("/dashboard");
  return access;
}

const id = z.uuid();

export async function newConversationAction() {
  const access = await requireAccess();
  const options = modeOptions(await withheldEngineModes(access.owner));
  const conversation = await createConversation(access.owner, {
    title: "New conversation",
    mode: "ask",
    engineMode: defaultMode(options) ?? "claude-coding",
  });
  redirect(`/chat?c=${conversation.id}`);
}

export async function setModeAction(formData: FormData) {
  const access = await requireAccess();
  const conversationId = id.parse(formData.get("conversationId"));
  // Build is not an option here: the database refuses it as well.
  const mode = z.enum(["ask", "plan"]).parse(formData.get("mode"));
  await updateConversation(access.owner, conversationId, { mode });
  revalidatePath("/chat");
}

export async function setEngineAction(formData: FormData) {
  const access = await requireAccess();
  const conversationId = id.parse(formData.get("conversationId"));
  const engineMode = String(formData.get("engineMode") ?? "");
  const option = modeOptions(await withheldEngineModes(access.owner)).find((o) => o.id === engineMode);
  if (!option?.available) redirect(`/chat?c=${conversationId}&error=engine`);
  await updateConversation(access.owner, conversationId, { engineMode });
  revalidatePath("/chat");
}

export async function addJobContextAction(formData: FormData) {
  const access = await requireAccess();
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
  const access = await requireAccess();
  const conversationId = id.parse(formData.get("conversationId"));
  const itemId = id.parse(formData.get("itemId"));
  await removeContextItem(access.owner, conversationId, itemId);
  revalidatePath("/chat");
}

export async function archiveConversationAction(formData: FormData) {
  const access = await requireAccess();
  const conversationId = id.parse(formData.get("conversationId"));
  await archiveConversation(access.owner, conversationId);
  redirect("/chat");
}
