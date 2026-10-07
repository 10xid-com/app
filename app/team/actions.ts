"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { sendInvitation } from "@/lib/auth/mailer";
import { loginOrigin } from "@/lib/auth/origin";
import { ROLE_TEMPLATES } from "@/lib/auth/permissions";
import {
  inviteToOrganization,
  revokeInvitation,
} from "@/lib/db/invitations";
import { organizationById } from "@/lib/db/identity";

/**
 * Inviting somebody.
 *
 * The business comes from the SESSION, never the form, and the central
 * authorization function decides who may: a role carrying `staff.manage`,
 * which today is the owner alone. A member being able to invite would mean one
 * compromised account quietly becomes several.
 *
 * The role is one of the six templates. Revision 2's invitation is tied to an
 * exact address, a business and a role, works once, and lapses after 7 days.
 */

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(ROLE_TEMPLATES),
});

async function requireInviter(formData: FormData) {
  const { ctx, businessId } = await requireAction("staff.manage", formData, {
    returnPath: "/team",
  });
  return { ctx, organizationId: businessId };
}

export async function inviteAction(formData: FormData) {
  const { ctx, organizationId } = await requireInviter(formData);

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) redirect("/team?error=email");

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
  const { organizationId } = await requireInviter(formData);

  const id = z.uuid().safeParse(formData.get("invitationId"));
  if (!id.success) redirect("/team?error=unknown");

  // The business comes from the session, so this cannot be pointed at another
  // business's invitation by editing the page. The tenant policy refuses it
  // underneath in any case.
  await revokeInvitation(organizationId, id.data);

  revalidatePath("/team");
  redirect("/team?done=revoked");
}
