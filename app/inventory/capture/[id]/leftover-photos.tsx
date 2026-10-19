"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CSRF_HEADER } from "@/lib/auth/csrf-names";
import { forget, sendPhoto, waitingFor, type QueuedPhoto } from "./photo-queue";

/**
 * Photos this phone still holds for an item that is no longer open.
 *
 * A photo taken offline is only on the phone until it is sent; if the item is
 * saved meanwhile from somewhere else (another tab, another phone), the photo
 * never reached 10XiD. It is not cleared because the item was saved: it is
 * shown here, and the person decides — add it to the saved item as evidence
 * (the portal links it to the container that save made, changes nothing in
 * the stock, and records the decision), or remove it from this phone. For a
 * discarded item the only choice is to remove it.
 */
export function LeftoverPhotos({ captureId, csrf, saved }: { captureId: string; csrf: string; saved: boolean }) {
  const router = useRouter();
  const [photos, setPhotos] = useState<(QueuedPhoto & { preview: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const previews = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    const urls = previews.current;
    void waitingFor(captureId).then((queue) => {
      if (!live) return;
      setPhotos(
        queue.map((q) => {
          const preview = URL.createObjectURL(q.blob);
          urls.add(preview);
          return { ...q, preview };
        }),
      );
    });
    return () => {
      live = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [captureId]);

  if (photos.length === 0) return null;
  const many = photos.length > 1;

  async function addToSaved() {
    setBusy(true);
    setMessage(null);
    const left: typeof photos = [];
    for (const photo of photos) {
      const result = await sendPhoto(photo, CSRF_HEADER, csrf, true);
      if (result.ok) {
        await forget(photo.key);
        continue;
      }
      setMessage(result.message);
      if (result.keep) left.push(photo);
      else await forget(photo.key);
    }
    setPhotos(left);
    setBusy(false);
    if (left.length < photos.length) router.refresh();
  }

  async function removeFromPhone() {
    setBusy(true);
    for (const photo of photos) await forget(photo.key);
    setPhotos([]);
    setBusy(false);
  }

  return (
    <div role="note" className="mb-4 rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm text-ink">
      <p className="font-semibold">
        {many ? `${photos.length} photos` : "A photo"} taken for this item on this phone {many ? "were" : "was"} never sent
        {saved ? " before it was saved." : "."}
      </p>
      <ul className="mt-3 grid grid-cols-4 gap-2">
        {photos.map((p) => (
          <li key={p.key} className="aspect-square overflow-hidden rounded-lg bg-sunk">
            {/* eslint-disable-next-line @next/next/no-img-element -- a photo on this device, not yet sent */}
            <img src={p.preview} alt="" className="h-full w-full object-cover" />
          </li>
        ))}
      </ul>
      {saved ? (
        <p className="mt-3">
          Add {many ? "them" : "it"} to the saved item as evidence: nothing in its stock changes. Or remove {many ? "them" : "it"} from this
          phone.
        </p>
      ) : (
        <p className="mt-3">This item was discarded, so {many ? "they have" : "it has"} nowhere to go. Remove {many ? "them" : "it"} from this phone.</p>
      )}
      {message ? <p className="mt-2 text-bad">{message}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {saved ? (
          <button
            type="button"
            onClick={addToSaved}
            disabled={busy}
            className="min-h-11 rounded-lg bg-brand-surface px-4 py-2 font-semibold text-brand-on-surface disabled:opacity-60"
          >
            {busy ? "Adding…" : `Add ${many ? "them" : "it"} to the saved item`}
          </button>
        ) : null}
        <button
          type="button"
          onClick={removeFromPhone}
          disabled={busy}
          className="min-h-11 rounded-lg border border-line bg-surface px-4 py-2 font-medium text-ink hover:bg-sunk disabled:opacity-60"
        >
          Remove {many ? "them" : "it"} from this phone
        </button>
      </div>
    </div>
  );
}
