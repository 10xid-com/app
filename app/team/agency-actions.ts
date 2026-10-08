"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { ROLE_TEMPLATES } from "@/lib/auth/permissions";
import {
  approveGrant,
  declineGrant,
  decideGrantPerson,
  revokeGrant,
  type GrantOutcome,
} from "@/lib/db/agency";

/**
 * The business's decisions on agency access (the Team page).
 *
 * Approving or declining a grant, and approving or unblocking a person, is
 * `grants.approve` — owners only, and never through agency access. Blocking a
 * person or ending a grant is `staff.manage` — owners and managers, never
 * through agency access. Every write names the session's business; login's
 * 0025 rules check the decider holds the role again, in the database.
 *
 * Anything that opens the business — approving a grant, approving or
 * unblocking a person — needs the authenticator within five minutes
 * (FRESHNESS_SECONDS.decision). Declining, blocking and ending never do:
 * closing access is not made harder.
 */

const AGENCY_ROLES = ROLE_TEMPLATES.filter((r) => r !== "owner") as [string, ...string[]];
const id = z.uuid();

function back(outcome: GrantOutcome, done: string): never {
  revalidatePath("/team");
  redirect(outcome === "done" ? `/team?agency=${done}#agency` : `/team?agency_error=${outcome}#agency`);
}

export async function approveGrantAction(formData: FormData) {
  const { ctx, businessId } = await requireAction("grants.approve", formData, { returnPath: "/team", fresh: "decision" });
  const parsed = z
    .object({ grantId: id, role: z.enum(AGENCY_ROLES), days: z.coerce.number().int().min(1).max(365) })
    .safeParse({ grantId: formData.get("grantId"), role: formData.get("role"), days: formData.get("days") });
  if (!parsed.success) back("refused", "");
  back(await approveGrant(businessId, parsed.data.grantId, ctx.userId, parsed.data.role, parsed.data.days), "approved");
}

export async function declineGrantAction(formData: FormData) {
  const { ctx, businessId } = await requireAction("grants.approve", formData, { returnPath: "/team" });
  const grantId = id.safeParse(formData.get("grantId"));
  if (!grantId.success) back("not_found", "");
  back(await declineGrant(businessId, grantId.data, ctx.userId), "declined");
}

export async function revokeGrantAction(formData: FormData) {
  const { ctx, businessId } = await requireAction("staff.manage", formData, { returnPath: "/team" });
  const grantId = id.safeParse(formData.get("grantId"));
  if (!grantId.success) back("not_found", "");
  back(await revokeGrant(businessId, grantId.data, ctx.userId), "revoked");
}

/** Approve, decline, block or unblock (approve again) one agency person. */
export async function decideAgencyPersonAction(formData: FormData) {
  const decision = z.enum(["approved", "declined", "blocked"]).safeParse(formData.get("decision"));
  if (!decision.success) back("refused", "");
  const { ctx, businessId } = await requireAction(
    decision.data === "approved" ? "grants.approve" : "staff.manage",
    formData,
    decision.data === "approved" ? { returnPath: "/team", fresh: "decision" } : { returnPath: "/team" },
  );
  const parsed = z.object({ grantId: id, userId: id }).safeParse({
    grantId: formData.get("grantId"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) back("not_found", "");
  back(
    await decideGrantPerson(businessId, parsed.data.grantId, parsed.data.userId, decision.data, ctx.userId),
    `person_${decision.data}`,
  );
}
