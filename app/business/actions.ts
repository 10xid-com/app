"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { BUSINESS_CHOOSER, requireSignedInAction } from "@/lib/auth/authorize";
import { setSessionActiveOrganization } from "@/lib/db/identity";
import { openableBusinesses } from "@/lib/auth/policy";

/**
 * Open one of your businesses.
 *
 * The business must be one the person is a member of, as a client business,
 * right now, or one a live agency grant reaches — read from the session,
 * never trusted from
 * the form. The choice is stored on this portal session only: another
 * browser, or the next sign-in, starts from its own choice. Every request
 * checks it again (activeBusiness in lib/auth/policy.ts), so a choice that
 * stops being a membership simply stops being on screen.
 *
 * Choosing grants nothing. What the person may do there is still the central
 * authorization function's, on every request, from their role in it.
 */
export async function switchBusinessAction(formData: FormData) {
  const ctx = await requireSignedInAction(formData, BUSINESS_CHOOSER);

  const id = z.uuid().safeParse(formData.get("organizationId"));
  const mine =
    id.success &&
    openableBusinesses(ctx.memberships, ctx.agencyAccess).some((b) => b.organizationId === id.data);
  if (!id.success || !mine) redirect(`${BUSINESS_CHOOSER}?error=not_yours`);

  await setSessionActiveOrganization(ctx.sessionId, id.data);
  // The dashboard rather than wherever they were: a page of the business they
  // just left (one job, say) is not in the business they just opened.
  redirect("/dashboard");
}
