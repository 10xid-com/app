import type { MembershipRole } from "@/lib/db/schema";

/**
 * WHAT A ROLE MAY DO.
 *
 * Pure data, no imports beyond a type, so the matrix can be read, diffed and
 * tested without a database or a request. The central authorization function
 * (./authorize.ts) is the only reader.
 *
 * The six role templates are Revision 2's; which template gets which action
 * is Paolo's matrix of 2026-10-07 (below). Two rules sit beside it, in pure
 * functions here, because they compare two roles rather than one:
 *
 *   * who may give which role (canAssignRole) — nobody but an owner can make
 *     an owner, so a manager cannot promote themselves through an invitation;
 *   * which status changes are decisions (statusChangeAction) — approving,
 *     asking for changes, cancelling, and undoing any of those, need
 *     `jobs.approve`, which only owners and managers hold.
 *
 * A third, that a business always keeps an owner, is the database's
 * (login's 0024 trigger), and is checked in app/team/actions.ts first so the
 * refusal is a sentence rather than an error.
 *
 * `member` and `staff` are the roles from before the templates. They remain
 * in the database because rows carry them, and they are granted nothing:
 * client-business `member` memberships became `viewer` in 0024 (service
 * accounts aside — an API key's integration user is a system, not a person),
 * and `staff` was turned off with the rest of staff access.
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
  "jobs.approve",
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
 * The matrix, as Paolo decided it on 2026-10-07.
 *
 *   owner          everything.
 *   manager        runs the business day to day: everything except billing,
 *                  domains, agency grants and ownership. May invite, change
 *                  and remove people, but never make or touch an owner.
 *   editor         writes: files and moves jobs, edits pages, drafts posts,
 *                  adds files. Does not publish or decide.
 *   publisher      an editor who may also publish.
 *   asset_manager  looks after files: the vault, sharing it, Drive folders.
 *   viewer         reads.
 *
 * Revision 2's two fixed rules hold: only an owner may transfer ownership or
 * approve an agency grant.
 */
const EDITOR: readonly BusinessAction[] = [
  "business.view",
  "jobs.read",
  "jobs.create",
  "jobs.update_status",
  "pages.edit",
  "vault.read",
  "vault.write",
  "social.compose",
];

const GRANTS: Record<RoleTemplate, readonly BusinessAction[]> = {
  owner: BUSINESS_ACTIONS,
  manager: [
    ...EDITOR,
    "jobs.approve",
    "jobs.attach_drive_folder",
    "staff.manage",
    "pages.publish",
    "vault.share",
    "social.publish",
    "social.connect",
  ],
  editor: EDITOR,
  publisher: [...EDITOR, "pages.publish", "social.publish"],
  asset_manager: [
    "business.view",
    "jobs.read",
    "jobs.create",
    "jobs.attach_drive_folder",
    "vault.read",
    "vault.write",
    "vault.share",
  ],
  viewer: ["business.view", "jobs.read", "vault.read"],
};

export const ROLE_PERMISSIONS: Record<RoleTemplate, ReadonlySet<BusinessAction>> = {
  owner: new Set(GRANTS.owner),
  manager: new Set(GRANTS.manager),
  editor: new Set(GRANTS.editor),
  publisher: new Set(GRANTS.publisher),
  asset_manager: new Set(GRANTS.asset_manager),
  viewer: new Set(GRANTS.viewer),
};

export function isRoleTemplate(role: string): role is RoleTemplate {
  return (ROLE_TEMPLATES as readonly string[]).includes(role);
}

/** Does this membership role carry this action? A non-template role carries none. */
export function roleAllows(role: string, action: BusinessAction): boolean {
  return isRoleTemplate(role) && ROLE_PERMISSIONS[role].has(action);
}

/* ------------------------------------------------------------------ */
/* People: who may give, change or take away which role.               */
/* ------------------------------------------------------------------ */

/**
 * May somebody holding `actorRole` give `targetRole` — by invitation, or by
 * changing a member's role? Only a role carrying `staff.manage` may give any
 * role, and only an owner may give `owner`: a manager who could invite an
 * owner could make themselves one with a second address.
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (!roleAllows(actorRole, "staff.manage") || !isRoleTemplate(targetRole)) return false;
  return targetRole !== "owner" || actorRole === "owner";
}

/**
 * May somebody holding `actorRole` change or remove a member who holds
 * `memberRole`, or withdraw an invitation to it? The same line: an owner's
 * membership, or an invitation that would make one, is an owner's business.
 */
export function canManageMember(actorRole: string, memberRole: string): boolean {
  if (!roleAllows(actorRole, "staff.manage")) return false;
  return memberRole !== "owner" || actorRole === "owner";
}

/* ------------------------------------------------------------------ */
/* Jobs: which status changes are decisions.                           */
/* ------------------------------------------------------------------ */

export const JOB_STATUSES = [
  "draft",
  "open",
  "in_progress",
  "awaiting_approval",
  "changes_requested",
  "approved",
  "completed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that record a decision about the work. */
const DECISIONS: ReadonlySet<JobStatus> = new Set(["approved", "changes_requested", "cancelled"]);

/**
 * Which action a status change needs.
 *
 * Making a decision needs `jobs.approve`; so does undoing one — leaving
 * `approved` for anything but `completed`, or reopening a job that was
 * `cancelled` or `completed` — and so does completing a job that was never
 * approved, which would be approving it by the back door. Moving work along
 * (draft → open → in progress → awaiting approval, approved → completed,
 * picking up requested changes) is `jobs.update_status`.
 */
export function statusChangeAction(
  from: JobStatus,
  to: JobStatus,
): "jobs.update_status" | "jobs.approve" {
  if (DECISIONS.has(to)) return "jobs.approve";
  if (to === "completed" && from !== "approved") return "jobs.approve";
  if (from === "approved" && to !== "completed") return "jobs.approve";
  if (from === "cancelled" || from === "completed") return "jobs.approve";
  return "jobs.update_status";
}

/** The statuses somebody holding `role` may move a job to from `from` (always including where it is). */
export function statusesFor(role: string, from: JobStatus): JobStatus[] {
  return JOB_STATUSES.filter((to) => to === from || roleAllows(role, statusChangeAction(from, to)));
}
