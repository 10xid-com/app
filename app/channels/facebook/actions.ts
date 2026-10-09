"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { connectSocial, disconnectSocial, SocialAccountTakenError } from "@/lib/db/social";
import { FacebookError, managedPages, whoSignedIn } from "@/lib/integrations/facebook";
import { FB_PENDING_COOKIE, openPending } from "@/lib/integrations/facebook-pending";

const BACK = "/channels/facebook";

/**
 * Connect the Page chosen from the ones the person manages. Their Facebook
 * token is the one waiting in their own cookie from the sign-in, for this
 * business; the Page and its token come from Facebook again, never from the
 * form. The waiting token is then thrown away.
 */
export async function chooseFacebookPageAction(formData: FormData) {
  const granted = await requireAction("social.connect", formData, { returnPath: BACK });
  const pageId = z.string().regex(/^\d{1,30}$/).parse(formData.get("pageId"));
  const jar = await cookies();
  const pending = openPending(jar.get(FB_PENDING_COOKIE)?.value, granted.businessId);
  if (!pending) redirect(`${BACK}?error=state`);

  let outcome = "done=connected";
  try {
    const [person, pages] = await Promise.all([whoSignedIn(pending.token), managedPages(pending.token)]);
    const page = pages.find((p) => p.id === pageId && p.canPost);
    if (!page) {
      outcome = "error=nopages";
    } else {
      await connectSocial({ organizationId: granted.businessId, userId: granted.ctx.userId }, "facebook", {
        accountId: page.id,
        scopedId: person.id,
        username: page.name,
        token: page.token,
        expiresAt: null,
        scopes: person.granted,
        agencyGrantId: granted.via?.grantId ?? null,
      });
    }
  } catch (err) {
    if (err instanceof SocialAccountTakenError) outcome = "error=taken";
    else if (err instanceof FacebookError) outcome = `error=facebook&detail=${encodeURIComponent(err.message.slice(0, 200))}`;
    else throw err;
  }
  jar.delete(FB_PENDING_COOKIE);
  redirect(`${BACK}?${outcome}`);
}

/** Disconnect the business's Facebook Page. Its token is erased; its history stays. */
export async function disconnectFacebookAction(formData: FormData) {
  const granted = await requireAction("social.connect", formData, { returnPath: BACK });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const id = z.uuid().parse(formData.get("connectionId"));
  await disconnectSocial(owner, id, granted.via?.grantId ?? null);
  redirect(`${BACK}?done=disconnected`);
}
