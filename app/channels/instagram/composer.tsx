"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CSRF_HEADER } from "@/lib/auth/csrf-names";

/**
 * Writing an Instagram post: one photo or a carousel of up to ten, a caption,
 * and a preview of the post as it will look in the feed.
 *
 * Instagram takes JPEG only, from 4:5 (tall) to 1.91:1 (wide), and crops a
 * carousel to the first photo's shape. So the shape is chosen once for the
 * whole post, and each photo is cropped to it from the centre, scaled to
 * Instagram's 1440px and converted to JPEG here in the browser — the preview
 * shows that same crop. Nothing leaves the browser until Post is pressed.
 */

const CAPTION_LIMIT = 2200;
const MAX_PHOTOS = 10;
const MAX_HASHTAGS = 30;
const WIDTH = 1440;

type Shape = "original" | "square" | "portrait" | "landscape";
const SHAPES: { value: Shape; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "square", label: "Square 1:1" },
  { value: "portrait", label: "Portrait 4:5" },
  { value: "landscape", label: "Landscape 1.91:1" },
];

type Photo = { id: string; file: File; url: string; width: number; height: number };

const clamp = (r: number) => Math.min(1.91, Math.max(0.8, r));

function ratioFor(shape: Shape, first: Photo | undefined): number {
  if (shape === "square") return 1;
  if (shape === "portrait") return 0.8;
  if (shape === "landscape") return 1.91;
  return first ? clamp(first.width / first.height) : 1;
}

/** Centre-crop to the ratio, scale to Instagram's width, JPEG. */
async function toJpeg(file: File, ratio: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (sw / sh > ratio) {
    sw = Math.round(sh * ratio);
    sx = Math.round((bitmap.width - sw) / 2);
  } else {
    sh = Math.round(sw / ratio);
    sy = Math.round((bitmap.height - sh) / 2);
  }
  const width = Math.min(WIDTH, sw);
  const height = Math.round(width / ratio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  // A transparent PNG goes on white, as Instagram would show it.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("This browser could not prepare the photo.");
  return blob;
}

async function asJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

const button =
  "rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk disabled:opacity-50";

export function Composer({ csrf, username }: { csrf: string; username: string }) {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [shape, setShape] = useState<Shape>("original");
  const [caption, setCaption] = useState("");
  const [shown, setShown] = useState(0);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null | undefined>(undefined);

  // Let go of the browser's copies when photos leave.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const held = urls.current;
    return () => held.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const ratio = ratioFor(shape, photos[0]);
  const hashtags = (caption.match(/(^|\s)#[^\s#]+/g) ?? []).length;
  const busy = step !== null;

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setPosted(undefined);
    const room = MAX_PHOTOS - photos.length;
    const added: Photo[] = [];
    for (const file of Array.from(files).slice(0, room)) {
      try {
        const bitmap = await createImageBitmap(file);
        const url = URL.createObjectURL(file);
        urls.current.add(url);
        added.push({ id: crypto.randomUUID(), file, url, width: bitmap.width, height: bitmap.height });
        bitmap.close();
      } catch {
        setError(`${file.name} could not be opened here. Save it as a JPEG or PNG and add it again.`);
      }
    }
    if (files.length > room) setError(`A post holds up to ${MAX_PHOTOS} photos.`);
    setPhotos((p) => [...p, ...added]);
    if (picker.current) picker.current.value = "";
  }

  function remove(id: string) {
    setPhotos((p) => {
      const gone = p.find((x) => x.id === id);
      if (gone) {
        URL.revokeObjectURL(gone.url);
        urls.current.delete(gone.url);
      }
      const next = p.filter((x) => x.id !== id);
      setShown((s) => Math.min(s, Math.max(0, next.length - 1)));
      return next;
    });
  }

  function move(id: string, by: -1 | 1) {
    setPhotos((p) => {
      const i = p.findIndex((x) => x.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function post() {
    setError(null);
    setPosted(undefined);
    try {
      const tokens: string[] = [];
      for (const [i, photo] of photos.entries()) {
        setStep(photos.length > 1 ? `Preparing photo ${i + 1} of ${photos.length}…` : "Preparing the photo…");
        const jpeg = await toJpeg(photo.file, ratio);
        const form = new FormData();
        form.set("photo", jpeg, "photo.jpg");
        const res = await fetch("/api/instagram/photos", { method: "POST", headers: { [CSRF_HEADER]: csrf }, body: form });
        const body = await asJson(res);
        if (!res.ok || typeof body.token !== "string") throw new Error(typeof body.error === "string" ? body.error : `The upload failed (${res.status}).`);
        tokens.push(body.token);
      }
      setStep("Posting to Instagram… this can take up to a minute.");
      const res = await fetch("/api/instagram/posts", {
        method: "POST",
        headers: { [CSRF_HEADER]: csrf, "content-type": "application/json" },
        body: JSON.stringify({ caption, photos: tokens }),
      });
      const body = await asJson(res);
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Instagram did not take the post (${res.status}).`);
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      setPhotos([]);
      setCaption("");
      setShown(0);
      setPosted(typeof body.permalink === "string" ? body.permalink : null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not post.");
    } finally {
      setStep(null);
    }
  }

  const current = photos[Math.min(shown, photos.length - 1)];
  const problem =
    photos.length === 0
      ? "Add a photo to post."
      : caption.length > CAPTION_LIMIT
        ? `The caption is over ${CAPTION_LIMIT.toLocaleString("en-CA")} characters.`
        : hashtags > MAX_HASHTAGS
          ? `Instagram allows ${MAX_HASHTAGS} hashtags; this has ${hashtags}.`
          : null;

  return (
    <div className="mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="grid content-start gap-4">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files)} />
            <button type="button" disabled={busy || photos.length >= MAX_PHOTOS} onClick={() => picker.current?.click()} className={button}>
              {photos.length ? "Add more photos" : "Add photos"}
            </button>
            <span className="text-xs text-ink-faint">One photo, or up to {MAX_PHOTOS} for a carousel.</span>
          </div>
          {photos.length ? (
            <ul className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <li key={p.id} className="grid w-24 gap-1">
                  <button
                    type="button"
                    onClick={() => setShown(i)}
                    aria-label={`Show photo ${i + 1}`}
                    className={`overflow-hidden rounded-lg border ${i === shown ? "border-brand ring-2 ring-brand/40" : "border-line"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- a photo chosen on this device */}
                    <img src={p.url} alt="" style={{ aspectRatio: String(ratio) }} className="w-full object-cover" />
                  </button>
                  <div className="flex justify-between text-xs">
                    <button type="button" disabled={busy || i === 0} onClick={() => move(p.id, -1)} aria-label="Move earlier" className="px-1 text-ink-soft hover:text-ink disabled:opacity-30">
                      ←
                    </button>
                    <button type="button" disabled={busy} onClick={() => remove(p.id)} className="px-1 text-ink-soft hover:text-bad">
                      Remove
                    </button>
                    <button type="button" disabled={busy || i === photos.length - 1} onClick={() => move(p.id, 1)} aria-label="Move later" className="px-1 text-ink-soft hover:text-ink disabled:opacity-30">
                      →
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <fieldset className="grid gap-1.5 text-sm" disabled={busy}>
          <legend className="mb-1.5 font-medium text-ink">Shape</legend>
          <div className="flex flex-wrap gap-1 rounded-lg bg-sunk p-0.5">
            {SHAPES.map((s) => (
              <label key={s.value} className={`cursor-pointer rounded-md px-3 py-1 text-[13px] font-semibold ${shape === s.value ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink"}`}>
                <input type="radio" name="shape" value={s.value} checked={shape === s.value} onChange={() => setShape(s.value)} className="sr-only" />
                {s.label}
              </label>
            ))}
          </div>
          <span className="text-xs text-ink-faint">
            Every photo in a post is cropped to one shape, from the centre.{shape === "original" && photos.length ? " Original keeps the first photo’s shape, within what Instagram allows." : ""}
          </span>
        </fieldset>

        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-ink">Caption</span>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={7}
            disabled={busy}
            placeholder="Write a caption… #hashtags work here too"
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
          />
          <span className={`text-xs ${caption.length > CAPTION_LIMIT || hashtags > MAX_HASHTAGS ? "text-bad" : "text-ink-faint"}`}>
            {caption.length.toLocaleString("en-CA")} / {CAPTION_LIMIT.toLocaleString("en-CA")} · {hashtags} / {MAX_HASHTAGS} hashtags
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void post()}
            disabled={busy || problem !== null}
            className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-50"
          >
            {busy ? "Posting…" : photos.length > 1 ? "Post carousel" : "Post"}
          </button>
          {step ? <span role="status" className="text-sm text-ink-soft">{step}</span> : problem && photos.length ? <span className="text-sm text-ink-soft">{problem}</span> : null}
        </div>
        {error ? (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {error}
          </p>
        ) : null}
        {posted !== undefined ? (
          <p role="status" className="rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
            Posted to Instagram.{" "}
            {posted ? (
              <a href={posted} target="_blank" rel="noreferrer" className="font-semibold underline">
                See it on Instagram
              </a>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="grid w-full max-w-[18rem] content-start gap-2 md:sticky md:top-4">
        <span className="text-sm font-medium text-ink">Preview</span>
        <article className="overflow-hidden rounded-xl border border-line bg-white text-[13px] text-neutral-900 shadow-card">
          <header className="flex items-center gap-2 px-3 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 text-xs font-bold text-white">
              {username.slice(0, 1).toUpperCase()}
            </span>
            <span className="font-semibold">{username}</span>
          </header>
          <div className="relative bg-neutral-100" style={{ aspectRatio: String(ratio) }}>
            {current ? (
              // eslint-disable-next-line @next/next/no-img-element -- a photo chosen on this device
              <img src={current.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-neutral-400">Your photo</span>
            )}
            {photos.length > 1 ? (
              <>
                <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
                  {Math.min(shown, photos.length - 1) + 1}/{photos.length}
                </span>
                <button type="button" aria-label="Previous photo" disabled={shown === 0} onClick={() => setShown((s) => Math.max(0, s - 1))} className="absolute left-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-neutral-800 shadow disabled:hidden">
                  ‹
                </button>
                <button type="button" aria-label="Next photo" disabled={shown >= photos.length - 1} onClick={() => setShown((s) => Math.min(photos.length - 1, s + 1))} className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-neutral-800 shadow disabled:hidden">
                  ›
                </button>
              </>
            ) : null}
          </div>
          {photos.length > 1 ? (
            <div className="flex justify-center gap-1 pt-2">
              {photos.map((p, i) => (
                <span key={p.id} className={`h-1.5 w-1.5 rounded-full ${i === Math.min(shown, photos.length - 1) ? "bg-sky-500" : "bg-neutral-300"}`} />
              ))}
            </div>
          ) : null}
          <p className="whitespace-pre-wrap break-words px-3 pb-3 pt-2">
            <span className="font-semibold">{username}</span> {caption || <span className="text-neutral-400">Your caption</span>}
          </p>
        </article>
      </div>
    </div>
  );
}
