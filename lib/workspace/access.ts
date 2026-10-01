import "server-only";
import type { SessionContext } from "@/lib/auth/session";
import type { Scope } from "@/lib/db";
import { internalOrganization, organizationById } from "@/lib/db/identity";
import type { WorkspaceOwner } from "@/lib/db/workspace";

/**
 * Who may use the workspace, and for which client.
 *
 * Staff only, and only as themselves: a session that has not cleared its
 * second factor, or that is acting as somebody else, gets nothing. The real
 * person's staff-ness decides it, never the effective identity's.
 *
 * The CLIENT comes from the session's live staff grant — the same 30-minute,
 * reason-stamped grant the Clients page writes — so opening a client's
 * workspace is recorded exactly like opening its jobs. With no grant held, the
 * workspace belongs to the house: the internal organization, which carries no
 * client's data.
 */
export type WorkspaceAccess = {
  owner: WorkspaceOwner;
  /** For the read-only record tools: scoped to this one client, never surveying. */
  scope: Scope;
  client: { id: string; name: string; isHouse: boolean };
};

export async function workspaceAccess(ctx: SessionContext | null): Promise<WorkspaceAccess | null> {
  if (!ctx || ctx.needsSecondFactor || ctx.actingAs || !ctx.realIsStaff || !ctx.scope.isStaff) {
    return null;
  }

  let organizationId = ctx.scope.organizationId;
  let isHouse = false;
  if (!organizationId) {
    const house = await internalOrganization();
    if (!house) return null;
    organizationId = house.id;
    isHouse = true;
  }

  const org = await organizationById(organizationId);
  if (!org) return null;

  return {
    owner: { organizationId, userId: ctx.realUserId },
    // isStaff stays true, but with an organization set the session is not
    // surveying (lib/db/index.ts isSurveying), so every read is this client's
    // rows only — the cross-client policy never applies inside a workspace.
    scope: { ...ctx.scope, organizationId },
    client: { id: org.id, name: org.name, isHouse },
  };
}
