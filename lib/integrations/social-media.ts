import "server-only";
import { deleteSocialMedia, takeExpiredSocialMedia, type SocialOwner } from "@/lib/db/social";
import { abortMultipart, deleteObject } from "./media-bucket";

/**
 * Removing files from the store along with their rows (lib/db/social.ts):
 * the row goes first, so a file whose delete fails is orphaned in a private
 * bucket rather than offered for posting again.
 */

/**
 * Only social uploads' own keys (`social/<business>/…`, login's 0035) are ever
 * deleted from here. The table's check already holds every key to that
 * prefix; this says it again where the delete happens, so nothing else in the
 * shared bucket — inventory photos above all — can be swept up by a cleanup.
 */
export function socialKeysOnly<T extends { storageKey: string }>(files: T[]): T[] {
  return files.filter((f) => {
    const ours = f.storageKey.startsWith("social/");
    if (!ours) console.warn("[social-media] refused to delete a key outside social/");
    return ours;
  });
}

async function removeFromStore(files: { storageKey: string; uploadId: string | null }[]): Promise<void> {
  await Promise.all(
    socialKeysOnly(files).map(async (f) => {
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
