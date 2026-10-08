import "server-only";
import type { SessionContext } from "@/lib/auth/session";
import type { Scope } from "@/lib/db";
import { organizationById } from "@/lib/db/identity";
import { mayUseChatBoss } from "@/lib/auth/chat-boss";
import type { WorkspaceOwner } from "@/lib/db/workspace";

/**
 * Chat Boss's business: the one the session has open, for a person on the
 * Chat Boss list (lib/auth/chat-boss.ts). The caller has already passed the
 * central authorization function for that business (requireChatBoss*), so
 * membership and role are settled; this re-checks the list and that the
 * business is a live client business, and never falls back to anything else.
 *
 * Every read is that business's rows only: the scope names it, and it is not
 * a staff scope, so no cross-client policy can apply.
 */
export type WorkspaceAccess = {
  owner: WorkspaceOwner;
  /** For the read-only record tools: scoped to this one business. */
  scope: Scope;
  client: { id: string; name: string; isHouse: boolean };
};

export async function workspaceAccess(ctx: SessionContext | null): Promise<WorkspaceAccess | null> {
  if (!ctx || ctx.needsSecondFactor || !mayUseChatBoss(ctx.email)) return null;
  const organizationId = ctx.scope.organizationId;
  if (!organizationId) return null;

  const org = await organizationById(organizationId);
  if (!org || org.type !== "client" || org.deletedAt) return null;

  return {
    owner: { organizationId, userId: ctx.userId },
    scope: { ...ctx.scope, organizationId, isStaff: false },
    client: { id: org.id, name: org.name, isHouse: false },
  };
}
