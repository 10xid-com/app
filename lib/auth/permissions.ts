import type { MembershipRole } from "@/lib/db/schema";

/**
 * WHAT A ROLE MAY DO.
 *
 * Pure data, no imports beyond a type, so the matrix can be read, diffed and
 * tested without a database or a request. The central authorization function
 * (./authorize.ts) is the only reader.
 *
 * The six role templates are Revision 2's. Which template gets which action is
 * the permission matrix, and the matrix has not been written yet. Until it is,
 * Paolo's decision of 2026-10-07 holds: `owner` gets every action, and the
 * other five get NONE. A manager or a viewer can therefore sign in and see
 * nothing, which is the intended result rather than a gap — inventing what a
 * viewer may view would be writing the matrix without its owner.
 *
 * `member` and `staff` are the roles from before the templates. They remain
 * in the database because rows carry them, and they are granted nothing:
 * `member` waits for the matrix like the five templates, and `staff` was
 * turned off with the rest of staff access.
 */

export const ROLE_TEMPLATES = [
  "owner",
  "manager",
  "editor",
  "publisher",
  "asset_manager",
  "viewer",
] as const satisfies readonly MembershipRole[];

export type RoleTemplate = (typeof ROLE_TEMPLATES)[number];

export const ROLE_LABELS: Record<RoleTemplate, string> = {
  owner: "Owner",
  manager: "Manager",
  editor: "Editor",
  publisher: "Publisher",
  asset_manager: "Asset manager",
  viewer: "Viewer",
};

/**
 * Every action a business member can be granted.
 *
 * The first group is what the portal does today. The second is Revision 2's
 * list for features not yet built; they are declared now so the owner's grant
 * is complete and the matrix has one list to be written against, but no route
 * checks them until the feature exists.
 */
export const BUSINESS_ACTIONS = [
  // The portal today.
  "business.view",
  "jobs.read",
  "jobs.create",
  "jobs.update_status",
  "jobs.attach_drive_folder",
  "staff.manage",
  // Revision 2, features not built yet.
  "pages.edit",
  "pages.publish",
  "vault.read",
  "vault.write",
  "vault.share",
  "social.compose",
  "social.publish",
  "social.connect",
  "domains.manage",
  "grants.approve",
  "billing.manage",
  "ownership.transfer",
] as const;

export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

/**
 * The matrix. Owner: everything. Everybody else: nothing, until it is written.
 *
 * Revision 2 adds two rules a future matrix must keep: only an owner may
 * transfer ownership or approve an agency grant. They hold here trivially.
 */
export const ROLE_PERMISSIONS: Record<RoleTemplate, ReadonlySet<BusinessAction>> = {
  owner: new Set(BUSINESS_ACTIONS),
  manager: new Set(),
  editor: new Set(),
  publisher: new Set(),
  asset_manager: new Set(),
  viewer: new Set(),
};

export function isRoleTemplate(role: string): role is RoleTemplate {
  return (ROLE_TEMPLATES as readonly string[]).includes(role);
}

/** Does this membership role carry this action? A non-template role carries none. */
export function roleAllows(role: string, action: BusinessAction): boolean {
  return isRoleTemplate(role) && ROLE_PERMISSIONS[role].has(action);
}
