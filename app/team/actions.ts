"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { sendInvitation } from "@/lib/auth/mailer";
import { loginOrigin } from "@/lib/auth/origin";
import { canAssignRole, canManageMember, ROLE_TEMPLATES } from "@/lib/auth/permissions";
import {
  inviteToOrganization,
  revokeInvitation,
} from "@/lib/db/invitations";
import { organizationById } from "@/lib/db/identity";
import {
  changeMemberRole,
  hasOwnerInvitation,
  invitationRole,
  memberOf,
  ownerCount,
  removeMember,
} from "@/lib/db/team";

/**
 * Inviting somebody.
 *
 * The business comes from the SESSION, never the form, and the central
 * authorization function decides who may: a role carrying `staff.manage` —
 * owners and managers. Only an owner may invite an owner, or withdraw or
 * replace an invitation to one (canAssignRole, canManageMember): a manager
 * who could would be one address away from owning the business.
 *
 * The role is one of the six templates. Revision 2's invitation is tied to an
 * exact address, a business and a role, works once, and lapses after 7 days.
 */

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(ROLE_TEMPLATES),
});

async function requireInviter(formData: FormData) {
  const { ctx, businessId, role } = await requireAction("staff.manage", formData, {
    returnPath: "/team",
  });
  return { ctx, organizationId: businessId, role };
}

export async function inviteAction(formData: FormData) {
  const { ctx, organizationId, role } = await requireInviter(formData);

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) redirect("/team?error=email");
  if (!canAssignRole(role, parsed.data.role)) redirect("/team?error=owner_only");
  if (role !== "owner" && (await hasOwnerInvitation(organizationId, parsed.data.email))) {
    redirect("/team?error=owner_only");
  }

  await inviteToOrganization({
    organizationId,
    email: parsed.data.email,
    role: parsed.data.role,
    invitedBy: ctx.userId,
  });

  const org = await organizationById(organizationId);

  /**
   * The invitation email is sent AFTER the row exists, and its failure is not
   * allowed to undo the invitation.
   *
   * The row is what grants anything; the message only tells somebody it is
   * there. If delivery fails, the invitation is still valid and can be pointed
   * at by hand — the alternative, rolling it back, would mean a transient mail
   * outage silently discards work somebody just did.
   */
  try {
    await sendInvitation({
      to: parsed.data.email,
      organizationName: org?.name ?? "your company",
      invitedByEmail: ctx.email,
      // Accounts are created on the login host, for exactly this address.
      signUpUrl: `${loginOrigin() ?? ""}/auth/sign-up`,
    });
  } catch (cause) {
    // The shape of the failure, never the payload or any credential.
    console.error(
      "[invite] the invitation was created but the email did not send:",
      cause instanceof Error ? cause.message : cause,
    );
    revalidatePath("/team");
    redirect("/team?error=mail");
  }

  revalidatePath("/team");
  redirect("/team?done=invited");
}

export async function revokeInvitationAction(formData: FormData) {
  const { organizationId, role } = await requireInviter(formData);

  const id = z.uuid().safeParse(formData.get("invitationId"));
  if (!id.success) redirect("/team?error=unknown");
  const invited = await invitationRole(organizationId, id.data);
  if (!invited) redirect("/team?error=unknown");
  if (!canManageMember(role, invited)) redirect("/team?error=owner_only");

  // The business comes from the session, so this cannot be pointed at another
  // business's invitation by editing the page. The tenant policy refuses it
  // underneath in any case.
  await revokeInvitation(organizationId, id.data);

  revalidatePath("/team");
  redirect("/team?done=revoked");
}

/* ------------------------------------------------------------------ */
/* Changing and removing members.                                      */
/* ------------------------------------------------------------------ */

const memberSchema = z.object({ userId: z.uuid() });

/**
 * The write only applies to the role the decision was made on (`moved`
 * otherwise): a viewer made an owner a moment ago is not removed by a
 * manager whose check saw a viewer.
 */
const OUTCOME_ERROR = { not_found: "no_member", moved: "moved", last_owner: "last_owner" } as const;

/**
 * The member being changed, if the person asking may change them: a real
 * member of THIS business (the session's), not a service account — an API
 * key's integration user belongs to the Keys screen — and not an owner unless
 * the person asking is one.
 */
async function requireManageable(formData: FormData) {
  const { ctx, organizationId, role } = await requireInviter(formData);
  const parsed = memberSchema.safeParse({ userId: formData.get("userId") });
  if (!parsed.success) redirect("/team?error=no_member");
  const member = await memberOf(organizationId, parsed.data.userId);
  if (!member || member.isService) redirect("/team?error=no_member");
  if (!canManageMember(role, member.role)) redirect("/team?error=owner_only");
  return { ctx, organizationId, role, member };
}

export async function changeRoleAction(formData: FormData) {
  const { organizationId, role, member } = await requireManageable(formData);

  const next = z.enum(ROLE_TEMPLATES).safeParse(formData.get("role"));
  if (!next.success) redirect("/team?error=no_member");
  if (!canAssignRole(role, next.data)) redirect("/team?error=owner_only");
  if (next.data === member.role) redirect("/team");

  // Checked here so the answer is a sentence; the database refuses it
  // regardless (0024), including when two owners step down at once.
  if (member.role === "owner" && (await ownerCount(organizationId)) <= 1) {
    redirect("/team?error=last_owner");
  }
  const outcome = await changeMemberRole(organizationId, member.userId, member.role, next.data);
  if (outcome !== "changed") redirect(`/team?error=${OUTCOME_ERROR[outcome]}`);

  revalidatePath("/team");
  redirect("/team?done=changed");
}

export async function removeMemberAction(formData: FormData) {
  const { ctx, organizationId, member } = await requireManageable(formData);

  if (member.role === "owner" && (await ownerCount(organizationId)) <= 1) {
    redirect("/team?error=last_owner");
  }
  const outcome = await removeMember(organizationId, member.userId, member.role);
  if (outcome !== "changed") redirect(`/team?error=${OUTCOME_ERROR[outcome]}`);

  // Removing yourself ends your access here on this request; there is
  // nothing left on the team page for you to see.
  if (member.userId === ctx.userId) redirect("/");
  revalidatePath("/team");
  redirect("/team?done=removed");
}
