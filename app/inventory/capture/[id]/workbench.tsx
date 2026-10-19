"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { CSRF_HEADER } from "@/lib/auth/csrf-names";
import { Icon } from "../../../_components/icons";
import { forget, keep, waitingFor, type QueuedPhoto } from "./photo-queue";

/**
 * The phone end of a capture: take or choose photos, send them, read them.
 *
 * Built for an iPhone in Safari first:
 *
 *   * "Take a photo" opens the camera (capture="environment"); "Choose from
 *     library" opens Photos. iOS hands the page a JPEG either way unless the
 *     library photo stays HEIC.
 *   * Each photo is redrawn here as a JPEG, at most 2048px on its long side,
 *     upright (the camera's orientation applied, then dropped) and without
 *     its metadata — the location a phone writes into every photo never
 *     leaves the phone. A HEIC this browser cannot open is sent as it is, if
 *     it is small enough; the reader skips it, a person can still read it.
 *   * Every photo is kept on the phone (./photo-queue.ts) until the portal
 *     says it is stored. No signal, a locked phone, a reload: it is sent when
 *     the page is open and the phone is online again, oldest first, one at a
 *     time, waiting longer after each failure.
 *   * The portal checks the hash computed here, and the same bytes sent twice
 *     are one photo — a retry can never make a second copy.
 */

type ServerPhoto = { id: string; contentType: string; state: "pending" | "stored" | "failed"; label: string | null };

type Local = {
  key: string;
  preview: string | null;
  status: "preparing" | "waiting" | "sending" | "sent" | "failed";
  message: string | null;
  documentId: string | null;
};

const MAX_EDGE = 2048;
const QUALITY = 0.85;
const MAX_BYTES = 9 * 1024 * 1024;

export function CaptureWorkbench({
  captureId,
  csrf,
  photos,
  reader,
  reading,
}: {
  captureId: string;
  csrf: string;
  photos: ServerPhoto[];
  /** Null when labels can be read here; otherwise why not. */
  reader: string | null;
  /** The last reading's outcome, as the page knows it. */
  reading: { status: string; error: string | null } | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Local[]>([]);
  const [busyReading, setBusyReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pumping = useRef(false);
  const again = useRef(false);
  const sentSome = useRef(false);
  const previews = useRef(new Set<string>());

  const update = useCallback((key: string, patch: Partial<Local>) => {
    setItems((all) => all.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

  /**
   * Send what is waiting, oldest first, one at a time. A failure that may
   * pass (no connection, the portal busy) stops the round and tries again
   * after a pause that doubles each time, up to a minute; a photo chosen
   * while a round is running is picked up by that round.
   */
  const pump = useCallback(async () => {
    if (pumping.current) {
      again.current = true;
      return;
    }
    pumping.current = true;
    if (timer.current) clearTimeout(timer.current);
    let paused = false;
    try {
      do {
        again.current = false;
        for (const photo of await waitingFor(captureId)) {
          update(photo.key, { status: "sending", message: null });
          const result = await send(photo, csrf);
          if (result.ok) {
            attempts.current = 0;
            sentSome.current = true;
            await forget(photo.key);
            update(photo.key, { status: "sent", documentId: result.documentId, message: result.note });
            continue;
          }
          if (result.keep) {
            update(photo.key, { status: "waiting", message: result.message });
            if (result.retry) {
              const delay = Math.min(60_000, 2_000 * 2 ** attempts.current);
              attempts.current += 1;
              timer.current = setTimeout(() => void pump(), delay);
            }
            paused = true;
            break;
          }
          await forget(photo.key);
          update(photo.key, { status: "failed", message: result.message });
        }
      } while (again.current && !paused);
      if (sentSome.current) {
        sentSome.current = false;
        router.refresh();
      }
    } finally {
      pumping.current = false;
    }
  }, [captureId, csrf, router, update]);

  // Whatever an earlier visit left unsent, and sending when the phone is back online.
  useEffect(() => {
    let live = true;
    const previewSet = previews.current;
    void waitingFor(captureId).then((queue) => {
      if (!live || queue.length === 0) return;
      setItems((all) => [
        ...all,
        ...queue
          .filter((q) => !all.some((i) => i.key === q.key))
          .map((q) => {
            const preview = URL.createObjectURL(q.blob);
            previewSet.add(preview);
            return { key: q.key, preview, status: "waiting" as const, message: null, documentId: null };
          }),
      ]);
      void pump();
    });
    const back = () => {
      attempts.current = 0;
      void pump();
    };
    window.addEventListener("online", back);
    return () => {
      live = false;
      window.removeEventListener("online", back);
      if (timer.current) clearTimeout(timer.current);
      for (const url of previewSet) URL.revokeObjectURL(url);
    };
  }, [captureId, pump]);

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setItems((all) => [...all, { key, preview: null, status: "preparing", message: null, documentId: null }]);
      try {
        const { blob, name } = await prepare(file);
        const preview = URL.createObjectURL(blob);
        previews.current.add(preview);
        const photo: QueuedPhoto = {
          key,
          captureId,
          blob,
          fileName: name,
          sha256: await sha256(blob),
          capturedAt: file.lastModified || null,
          addedAt: Date.now(),
        };
        await keep(photo);
        update(key, { preview, status: "waiting" });
      } catch (err) {
        update(key, { status: "failed", message: err instanceof Error ? err.message : "That photo could not be prepared." });
      }
    }
    attempts.current = 0;
    void pump();
  }

  async function readLabels() {
    setBusyReading(true);
    setReadError(null);
    try {
      const res = await fetch(`/api/inventory/captures/${captureId}/extract`, { method: "POST", headers: { [CSRF_HEADER]: csrf } });
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (!res.ok) setReadError(body.error ?? "The labels could not be read.");
      else if (body.status === "failed") setReadError(body.error ?? "The labels could not be read.");
      router.refresh();
    } catch {
      setReadError("No connection. Try again when you are back online.");
    } finally {
      setBusyReading(false);
    }
  }

  const onServer = new Set(photos.map((p) => p.id));
  const local = items.filter((i) => !(i.status === "sent" && i.documentId && onServer.has(i.documentId)));
  const pending = items.some((i) => i.status === "preparing" || i.status === "waiting" || i.status === "sending");
  const stored = photos.filter((p) => p.state === "stored");

  return (
    <section aria-labelledby="photos-heading" className="mt-6 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
      <h2 id="photos-heading" className="text-lg font-semibold text-ink">
        Photos
      </h2>
      <p className="mt-1 text-sm text-ink-soft">The front, the back panel, and the lot and date. As many as it takes to read it.</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl bg-brand-surface px-4 py-3 text-base font-semibold text-brand-on-surface hover:bg-brand-surface-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand">
          <Icon name="camera" />
          Take a photo
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={chosen} />
        </label>
        <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-base font-semibold text-ink hover:bg-sunk focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand">
          <Icon name="photos" />
          Choose from library
          <input type="file" accept="image/*" multiple className="sr-only" onChange={chosen} />
        </label>
      </div>

      {!online ? (
        <p role="status" className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink">
          No connection. Photos are kept on this phone and sent when it is back online.
        </p>
      ) : null}

      {photos.length || local.length ? (
        <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="relative aspect-square overflow-hidden rounded-lg bg-sunk">
              {p.state === "stored" ? (
                <Thumb src={`/api/inventory/documents/${p.id}`} heic={p.contentType === "image/heic" || p.contentType === "image/heif"} />
              ) : (
                <span className="grid h-full place-items-center p-2 text-center text-xs text-ink-soft">
                  {p.state === "failed" ? "Not stored — add it again" : "Being stored…"}
                </span>
              )}
              {p.label ? (
                <span className="absolute inset-x-0 bottom-0 bg-ink/70 px-1.5 py-0.5 text-[11px] text-white">{p.label}</span>
              ) : null}
            </li>
          ))}
          {local.map((i) => (
            <li key={i.key} className="relative aspect-square overflow-hidden rounded-lg bg-sunk">
              {i.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- a photo on this device, not yet sent
                <img src={i.preview} alt="" className={`h-full w-full object-cover ${i.status === "sent" ? "" : "opacity-60"}`} />
              ) : null}
              <span
                className={`absolute inset-x-0 bottom-0 px-1.5 py-0.5 text-[11px] ${
                  i.status === "failed" ? "bg-bad text-white" : "bg-ink/70 text-white"
                }`}
              >
                {STATUS[i.status]}
              </span>
              {i.message && i.status !== "sent" ? <span className="sr-only">{i.message}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {local.some((i) => i.message && i.status !== "sent") ? (
        <ul className="mt-3 grid gap-1 text-sm">
          {local
            .filter((i) => i.message && i.status !== "sent")
            .map((i) => (
              <li key={i.key} className={i.status === "failed" ? "text-bad" : "text-ink-soft"}>
                {i.message}
              </li>
            ))}
        </ul>
      ) : null}

      <div className="mt-5 border-t border-line pt-4">
        {reader ? (
          <p className="text-sm text-ink-soft">Automatic reading is off here. Fill in what you can below.</p>
        ) : (
          <>
            <button
              type="button"
              onClick={readLabels}
              disabled={busyReading || pending || stored.length === 0}
              aria-busy={busyReading}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/5 px-4 py-3 text-base font-semibold text-brand disabled:opacity-50 sm:w-auto"
            >
              <Icon name="sparkle" />
              {busyReading ? "Reading the labels…" : reading?.status === "needs_review" || reading?.status === "reviewed" ? "Read the labels again" : "Read the labels"}
            </button>
            <p className="mt-2 text-xs text-ink-faint">
              {busyReading
                ? "This can take up to a minute."
                : pending
                  ? "Waiting for every photo to be sent."
                  : "Nothing is saved until you check it below and press Save."}
            </p>
          </>
        )}
        {readError ?? (reading?.status === "failed" ? reading.error : null) ? (
          <p role="alert" className="mt-2 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {readError ?? reading?.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function subscribeOnline(changed: () => void) {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  return () => {
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", changed);
  };
}

const STATUS: Record<Local["status"], string> = {
  preparing: "Preparing…",
  waiting: "Waiting to send",
  sending: "Sending…",
  sent: "Sent",
  failed: "Not sent",
};

function Thumb({ src, heic }: { src: string; heic: boolean }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className="grid h-full place-items-center p-2 text-center text-xs text-ink-soft">
        {heic ? "HEIC photo (shows in Safari)" : "Photo"}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- a private photo served per request
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" />;
}

/* ------------------------------------------------------------------ */
/* Preparing a photo                                                   */
/* ------------------------------------------------------------------ */

const isHeic = (file: File) => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

type Decoded = { source: CanvasImageSource; width: number; height: number; done: () => void };

/** The photo as pixels, upright: createImageBitmap first, an <img> (which Safari decodes HEIC into) second. */
async function decode(file: File): Promise<Decoded | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
  } catch {
    /* fall through */
  }
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try {
      await img.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    return null;
  }
}

async function prepare(file: File): Promise<{ blob: Blob; name: string }> {
  const decoded = await decode(file);
  const stem = (file.name || "photo").replace(/\.[^.]+$/, "").slice(0, 80) || "photo";
  if (!decoded || !decoded.width || !decoded.height) {
    decoded?.done();
    if (isHeic(file) && file.size <= MAX_BYTES) return { blob: file, name: `${stem}.heic` };
    throw new Error(isHeic(file) ? "That HEIC photo is too large to send as it is. Take it again with the camera button." : "This browser could not open that photo.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    decoded.done();
    throw new Error("This browser could not prepare the photo.");
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(decoded.source, 0, 0, width, height);
  decoded.done();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
  canvas.width = canvas.height = 0; // let iOS have the memory back now
  if (!blob) throw new Error("This browser could not prepare the photo.");
  if (blob.size > MAX_BYTES) throw new Error("That photo is too large to send.");
  return { blob, name: `${stem}.jpg` };
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

type Sent =
  | { ok: true; documentId: string; note: string | null }
  | {
      ok: false;
      /** Keep it on the phone for a later try (else it is dropped, with the reason). */
      keep: boolean;
      /** Try again on its own after a pause (else when the page or the connection comes back). */
      retry: boolean;
      message: string;
    };

async function send(photo: QueuedPhoto, csrf: string): Promise<Sent> {
  const form = new FormData();
  form.append("photo", photo.blob, photo.fileName);
  form.append("sha256", photo.sha256);
  if (photo.capturedAt) form.append("capturedAt", String(photo.capturedAt));
  let res: Response;
  try {
    res = await fetch(`/api/inventory/captures/${photo.captureId}/photos`, {
      method: "POST",
      headers: { [CSRF_HEADER]: csrf },
      body: form,
    });
  } catch {
    return { ok: false, keep: true, retry: true, message: "Not sent yet: no connection. It is kept on this phone." };
  }
  const body = (await res.json().catch(() => ({}))) as {
    documentId?: string;
    error?: string;
    evidenceFor?: { productName: string }[];
  };
  if (res.ok && body.documentId) {
    const already = body.evidenceFor?.[0]?.productName;
    return { ok: true, documentId: body.documentId, note: already ? `This photo is already saved with ${already}.` : null };
  }
  if (res.status === 401) {
    return { ok: false, keep: true, retry: false, message: "You were signed out. Sign in again and reopen this item: the photo is kept and will be sent." };
  }
  if (res.status >= 500 || res.status === 408 || res.status === 429 || res.status === 422) {
    return { ok: false, keep: true, retry: true, message: body.error ?? "Not sent yet. It will be tried again." };
  }
  return { ok: false, keep: false, retry: false, message: body.error ?? `That photo was refused (${res.status}).` };
}
