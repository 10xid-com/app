"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { disconnectInstagram } from "@/lib/db/social";

const BACK = "/channels/instagram";

/** Disconnect the business's Instagram account. Its token is erased; its history stays. */
export async function disconnectInstagramAction(formData: FormData) {
  const granted = await requireAction("social.connect", formData, { returnPath: BACK });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const id = z.uuid().parse(formData.get("connectionId"));
  await disconnectInstagram(owner, id, granted.via?.grantId ?? null);
  redirect(`${BACK}?done=disconnected`);
}
