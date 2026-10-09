import "server-only";
import { deleteSocialMedia, takeExpiredSocialMedia, type SocialOwner } from "@/lib/db/social";
import { abortMultipart, deleteObject } from "./media-bucket";

/**
 * Removing files from the store along with their rows (lib/db/social.ts):
 * the row goes first, so a file whose delete fails is orphaned in a private
 * bucket rather than offered for posting again.
 */

async function removeFromStore(files: { storageKey: string; uploadId: string | null }[]): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      // An upload still open has parts but no object; a finished one, the reverse. Either way, both.
      if (f.uploadId) await abortMultipart(f.storageKey, f.uploadId);
      await deleteObject(f.storageKey).catch(() => undefined);
    }),
  );
}

export async function forgetSocialMedia(owner: SocialOwner, ids: string[]): Promise<void> {
  await removeFromStore(await deleteSocialMedia(owner, ids));
}

/** This business's files left over from posts never made, past their 24 hours. */
export async function sweepExpiredSocialMedia(owner: SocialOwner): Promise<void> {
  await removeFromStore(await takeExpiredSocialMedia(owner));
}
