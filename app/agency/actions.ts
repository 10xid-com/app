"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { ROLE_TEMPLATES } from "@/lib/auth/permissions";
import { sendAgencyNotice } from "@/lib/auth/mailer";
import { appOrigin } from "@/lib/auth/origin";
import {
  addGrantPerson,
  grantsForAgency,
  ownerEmailsOf,
  removeGrantPerson,
  renewGrant,
  requestGrant,
  withdrawGrant,
  type GrantOutcome,
} from "@/lib/db/agency";
import { organizationById } from "@/lib/db/identity";

/**
 * The agency's side (the Agency page): ask a business for access, name its
 * own people on a grant, take them off, withdraw.
 *
 * Only an owner or manager of the agency, with the agency open (staff.manage
 * on it, which no agency access carries), and only for an organization that
 * is an agency. Nothing here grants anything: the business decides, person by
 * person, and login's 0025 rules hold the agency to that.
 */

const AGENCY_ROLES = ROLE_TEMPLATES.filter((r) => r !== "owner") as [string, ...string[]];
const id = z.uuid();

async function requireAgency(formData: FormData) {
  const granted = await requireAction("staff.manage", formData, { returnPath: "/agency" });
  const agency = await organizationById(granted.businessId);
  if (!agency?.isAgency) notFound();
  return { ...granted, agency };
}

function back(outcome: GrantOutcome, done: string): never {
  revalidatePath("/agency");
  redirect(outcome === "done" ? `/agency?done=${done}` : `/agency?error=${outcome}`);
}

async function notify(businessId: string, agencyName: string, what: string) {
  const business = await organizationById(businessId);
  try {
    await sendAgencyNotice({
      to: await ownerEmailsOf(businessId),
      businessName: business?.name ?? "your business",
      agencyName,
      what,
      teamUrl: `${appOrigin() ?? ""}/team#agency`,
    });
  } catch (cause) {
    // The request stands; the notice is a courtesy.
    console.error("[agency] notice did not send:", cause instanceof Error ? cause.message : cause);
  }
}

export async function requestAccessAction(formData: FormData) {
  const { ctx, agency } = await requireAgency(formData);
  const parsed = z
    .object({
      businessRef: z.string().trim().min(2).max(100),
      role: z.enum(AGENCY_ROLES),
      days: z.coerce.number().int().min(1).max(365),
      reason: z.string().trim().min(8).max(500),
    })
    .safeParse({
      businessRef: formData.get("businessRef"),
      role: formData.get("role") ?? "editor",
      days: formData.get("days") ?? 90,
      reason: formData.get("reason"),
    });
  if (!parsed.success) back("refused", "");
  const result = await requestGrant({ agencyId: agency.id, requestedBy: ctx.userId, ...parsed.data, durationDays: parsed.data.days });
  if (result.outcome === "done" && result.businessId) {
    await notify(result.businessId, agency.name, `asked for ${parsed.data.role} access for ${parsed.data.days} days`);
  }
  // Asked, or no such business: the same answer, so a reference cannot be
  // probed from here.
  back(result.outcome === "not_found" ? "done" : result.outcome, "asked");
}

/**
 * Ask to renew access ending within seven days, or ended (login's 0026): a
 * new request the business's owner decides on, with the people approved
 * before named again for the owner to approve one by one.
 */
export async function renewGrantAction(formData: FormData) {
  const { ctx, agency } = await requireAgency(formData);
  const grantId = id.safeParse(formData.get("grantId"));
  if (!grantId.success) back("not_found", "");
  const result = await renewGrant(agency.id, grantId.data, ctx.userId);
  if (result.outcome === "done" && result.businessId) {
    await notify(result.businessId, agency.name, "asked to renew its access");
  }
  back(result.outcome, "renewal");
}

export async function addAgencyPersonAction(formData: FormData) {
  const { ctx, agency } = await requireAgency(formData);
  const parsed = z.object({ grantId: id, userId: id }).safeParse({
    grantId: formData.get("grantId"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) back("not_found", "");
  const outcome = await addGrantPerson(agency.id, parsed.data.grantId, parsed.data.userId, ctx.userId);
  if (outcome === "done") {
    const grant = (await grantsForAgency(agency.id)).find((g) => g.id === parsed.data.grantId);
    if (grant) await notify(grant.otherOrganizationId, agency.name, "named a person to work on its access");
  }
  back(outcome, "named");
}

export async function removeAgencyPersonAction(formData: FormData) {
  const { ctx, agency } = await requireAgency(formData);
  const parsed = z.object({ grantId: id, userId: id }).safeParse({
    grantId: formData.get("grantId"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) back("not_found", "");
  back(await removeGrantPerson(agency.id, parsed.data.grantId, parsed.data.userId, ctx.userId), "removed");
}

export async function withdrawGrantAction(formData: FormData) {
  const { ctx, agency } = await requireAgency(formData);
  const grantId = id.safeParse(formData.get("grantId"));
  if (!grantId.success) back("not_found", "");
  back(await withdrawGrant(agency.id, grantId.data, ctx.userId), "withdrawn");
}
