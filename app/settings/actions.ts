"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { updateBusinessDetails } from "@/lib/db/identity";

const detailsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  // A colour as the brand guide gives it: #RRGGBB.
  brandPrimaryHex: z
    .string()
    .trim()
    .regex(/^(#[0-9a-fA-F]{6})?$/)
    .transform((v) => v.toLowerCase() || null),
  // Shown in the portal's own pages, so only an https address.
  brandLogoUrl: z
    .string()
    .trim()
    .pipe(z.union([z.literal(""), z.url({ protocol: /^https$/ }).max(500)]))
    .transform((v) => v || null),
  memberVisibility: z.enum(["open", "closed"]),
});

/**
 * The business's own details. Which business is the session's, from the
 * central function, never a field on the form: the table has no row-level
 * security to fall back on.
 */
export async function saveBusinessDetailsAction(formData: FormData) {
  const { ctx, businessId, via } = await requireAction("business.edit", formData, { returnPath: "/settings" });

  const parsed = detailsSchema.safeParse({
    name: formData.get("name") ?? "",
    brandPrimaryHex: formData.get("brandPrimaryHex") ?? "",
    brandLogoUrl: formData.get("brandLogoUrl") ?? "",
    memberVisibility: formData.get("memberVisibility"),
  });
  if (!parsed.success) {
    redirect(`/settings?error=${String(parsed.error.issues[0]?.path[0] ?? "form")}`);
  }

  const changed = await updateBusinessDetails(
    businessId,
    { userId: ctx.userId, agencyGrantId: via?.grantId ?? null },
    parsed.data,
  );

  // The name and logo are on every screen's navigation.
  revalidatePath("/", "layout");
  redirect(changed.length ? "/settings?saved=1" : "/settings?saved=0");
}
