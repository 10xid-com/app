"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CSRF_HEADER } from "@/lib/auth/csrf-names";
import { drawableText, wholeVideo, type VideoEdit } from "@/lib/integrations/video-edit-spec";
import { clock, VideoEditor, VideoPreview, type VideoShape } from "./video-editor";
import {
  CAROUSEL_VIDEO_MAX_MS,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_MS,
  VIDEO_MIN_MS,
} from "@/lib/integrations/video-limits";

/**
 * Writing a post for a social channel, with a preview of it as it will look.
 *
 * Instagram: one photo, one video (posted as a Reel), or a carousel of up to
 * ten photos and videos, with a caption.
 *
 * Facebook (a Page): text on its own, text with up to ten photos, or text
 * with one video. Photos keep their own shape.
 *
 * Photos: Instagram takes JPEG only, from 4:5 (tall) to 1.91:1 (wide), and
 * crops a carousel to its first item's shape. So for Instagram the shape is
 * chosen once for the whole post, and each photo is cropped to it from the
 * centre, scaled to Instagram's 1440px and converted to JPEG here in the
 * browser — the preview shows that same crop. For Facebook a photo is only
 * converted, and scaled to 2048px at most.
 *
 * Videos go up as they are (MP4 or MOV), in 8MB parts, and are then edited
 * on the server (./video-editor.tsx: trim, shape, sound, text) into an MP4
 * every channel takes. Instagram does its own processing after that, which
 * can take a few minutes. A video on its own is a Reel: it can also show in
 * the main feed, and its cover can be any frame of the kept part.
 *
 * Nothing leaves the browser until Post is pressed.
 */

export type SocialComposerChannel = "instagram" | "facebook";

const RULES = {
  instagram: { textLimit: 2200, maxHashtags: 30, width: 1440, endpoint: "/api/instagram/posts", name: "Instagram" },
  facebook: { textLimit: 63_206, maxHashtags: Infinity, width: 2048, endpoint: "/api/facebook/posts", name: "Facebook" },
} as const;
const MAX_ITEMS = 10;

/** The shapes a video on its own can be cropped to. */
const VIDEO_SHAPES: Record<SocialComposerChannel, VideoShape[]> = {
  instagram: [
    { label: "Original", ratio: null },
    { label: "9:16 Reel", ratio: 9 / 16 },
    { label: "4:5", ratio: 0.8 },
    { label: "1:1", ratio: 1 },
  ],
  facebook: [
    { label: "Original", ratio: null },
    { label: "9:16", ratio: 9 / 16 },
    { label: "4:5", ratio: 0.8 },
    { label: "1:1", ratio: 1 },
    { label: "16:9", ratio: 16 / 9 },
  ],
};

type Shape = "original" | "square" | "portrait" | "landscape";
const SHAPES: { value: Shape; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "square", label: "Square 1:1" },
  { value: "portrait", label: "Portrait 4:5" },
  { value: "landscape", label: "Landscape 1.91:1" },
];

type Item = {
  id: string;
  kind: "photo" | "video";
  file: File;
  type: string;
  url: string;
  width: number;
  height: number;
  durationMs: number | null;
};

const clamp = (r: number) => Math.min(1.91, Math.max(0.8, r));

function ratioFor(shape: Shape, first: Item | undefined): number {
  if (shape === "square") return 1;
  if (shape === "portrait") return 0.8;
  if (shape === "landscape") return 1.91;
  return first ? clamp(first.width / first.height) : 1;
}

/** MP4 or MOV, by type or, when the browser gives none, by name. */
function videoType(file: File): string | null {
  if (file.type === "video/mp4" || file.type === "video/quicktime") return file.type;
  if (/\.mp4$|\.m4v$/i.test(file.name)) return "video/mp4";
  if (/\.mov$/i.test(file.name)) return "video/quicktime";
  return null;
}

const isVideo = (file: File) => file.type.startsWith("video/") || /\.(mp4|m4v|mov)$/i.test(file.name);

/** A video's size and length, read by the browser without playing it. */
function videoInfo(url: string): Promise<{ width: number; height: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    const timer = setTimeout(() => reject(new Error("timeout")), 20_000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      // A codec this browser cannot show still has a length; its size is then unknown, so assume a phone video.
      resolve({ width: v.videoWidth || 1080, height: v.videoHeight || 1920, durationMs: Math.round(v.duration * 1000) });
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error("unreadable"));
    };
    v.src = url;
  });
}

/** Centre-crop to the ratio (or keep the photo's own, given null), scale to the width, JPEG. */
async function toJpeg(file: File, wanted: number | null, maxWidth: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const ratio = wanted ?? bitmap.width / bitmap.height;
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
  // The longer side at most maxWidth, for a tall photo kept as it is.
  const width = Math.min(sw, ratio >= 1 ? maxWidth : Math.round(maxWidth * ratio));
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

const failed = (body: Record<string, unknown>, fallback: string) => new Error(typeof body.error === "string" ? body.error : fallback);

const seconds = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
};

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)}MB`;

const button =
  "rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk disabled:opacity-50";

export function SocialComposer({
  channel,
  csrf,
  username,
  picture = null,
}: {
  channel: SocialComposerChannel;
  csrf: string;
  /** The Instagram username, or the Page's name. */
  username: string;
  picture?: string | null;
}) {
  const rules = RULES[channel];
  const facebook = channel === "facebook";
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [shape, setShape] = useState<Shape>("original");
  const [caption, setCaption] = useState("");
  const [shown, setShown] = useState(0);
  const [shareToFeed, setShareToFeed] = useState(true);
  const [coverMs, setCoverMs] = useState(0);
  const [edits, setEdits] = useState<Record<string, VideoEdit>>({});
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null | undefined>(undefined);

  // Let go of the browser's copies when the composer goes.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const held = urls.current;
    return () => held.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const reel = !facebook && items.length === 1 && items[0].kind === "video" ? items[0] : null;
  const ratio = facebook ? (items[0] ? items[0].width / items[0].height : 1.91) : ratioFor(shape, items[0]);
  const hashtags = (caption.match(/(^|\s)#[^\s#]+/g) ?? []).length;
  const busy = step !== null;
  const current = items[Math.min(shown, items.length - 1)];
  const inCarousel = !facebook && items.length > 1;

  /** A video's edits as they will be made: in a carousel, the post's shape is its shape. */
  const editFor = (item: Item): VideoEdit => {
    const e = edits[item.id] ?? wholeVideo(item.durationMs ?? 0);
    return {
      ...e,
      crop: { ratio: inCarousel ? ratio : e.crop.ratio, position: e.crop.position },
      texts: e.texts.filter((t) => drawableText(t.text)),
    };
  };
  const currentEdit = current?.kind === "video" ? editFor(current) : null;
  const previewBox =
    reel && currentEdit
      ? (currentEdit.crop.ratio ?? 9 / 16)
      : facebook && current?.kind === "video" && currentEdit
        ? (currentEdit.crop.ratio ?? current.width / current.height)
        : ratio;

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setPosted(undefined);
    const room = MAX_ITEMS - items.length;
    const added: Item[] = [];
    const problems: string[] = [];
    for (const file of Array.from(files).slice(0, room)) {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      try {
        if (isVideo(file)) {
          const type = videoType(file);
          if (!type) throw new Error(`${file.name}: Instagram takes MP4 or MOV video.`);
          if (file.size > VIDEO_MAX_BYTES) throw new Error(`${file.name} is ${megabytes(file.size)}; Instagram takes videos up to 300MB.`);
          const info = await videoInfo(url).catch(() => {
            throw new Error(`${file.name} could not be read here. Export it as an MP4 (H.264) and add it again.`);
          });
          if (info.durationMs < VIDEO_MIN_MS || info.durationMs > VIDEO_MAX_MS) {
            throw new Error(`${file.name} is ${seconds(info.durationMs)} long; Instagram takes videos from 3 seconds to 15 minutes.`);
          }
          const id = crypto.randomUUID();
          added.push({ id, kind: "video", file, type, url, ...info });
          setEdits((e) => ({ ...e, [id]: wholeVideo(info.durationMs) }));
        } else {
          const bitmap = await createImageBitmap(file).catch(() => {
            throw new Error(`${file.name} could not be opened here. Save it as a JPEG or PNG and add it again.`);
          });
          added.push({ id: crypto.randomUUID(), kind: "photo", file, type: "image/jpeg", url, width: bitmap.width, height: bitmap.height, durationMs: null });
          bitmap.close();
        }
      } catch (err) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        problems.push(err instanceof Error ? err.message : `${file.name} could not be added.`);
      }
    }
    if (files.length > room) problems.push(`A post holds up to ${MAX_ITEMS} photos and videos.`);
    if (problems.length) setError(problems.join(" "));
    setItems((p) => [...p, ...added]);
    setCoverMs(0);
    if (picker.current) picker.current.value = "";
  }

  function remove(id: string) {
    const gone = items.find((x) => x.id === id);
    if (gone) {
      URL.revokeObjectURL(gone.url);
      urls.current.delete(gone.url);
    }
    const next = items.filter((x) => x.id !== id);
    setItems(next);
    setEdits((e) => {
      const rest = { ...e };
      delete rest[id];
      return rest;
    });
    setShown((s) => Math.min(s, Math.max(0, next.length - 1)));
    setCoverMs(0);
  }

  function move(id: string, by: -1 | 1) {
    setItems((p) => {
      const i = p.findIndex((x) => x.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function uploadPhoto(item: Item): Promise<string> {
    const jpeg = await toJpeg(item.file, facebook ? null : ratio, rules.width);
    const form = new FormData();
    form.set("photo", jpeg, "photo.jpg");
    const res = await fetch("/api/social/photos", { method: "POST", headers: { [CSRF_HEADER]: csrf }, body: form });
    const body = await asJson(res);
    if (!res.ok || typeof body.id !== "string") throw failed(body, `The photo did not upload (${res.status}).`);
    return body.id;
  }

  async function uploadVideo(item: Item, label: string): Promise<string> {
    const json = { [CSRF_HEADER]: csrf, "content-type": "application/json" };
    const start = await fetch("/api/social/videos", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        contentType: item.type,
        byteSize: item.file.size,
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
      }),
    });
    const started = await asJson(start);
    if (!start.ok || typeof started.id !== "string" || typeof started.partBytes !== "number") {
      throw failed(started, `The video did not start uploading (${start.status}).`);
    }
    const { id, partBytes } = started as { id: string; partBytes: number };
    const total = Math.ceil(item.file.size / partBytes);
    const parts: { part: number; etag: string }[] = [];
    for (let part = 1; part <= total; part++) {
      setStep(`${label} ${Math.round(((part - 1) / total) * 100)}%`);
      const chunk = item.file.slice((part - 1) * partBytes, part * partBytes);
      let etag: string | null = null;
      // A part that fails is sent again, twice, before giving up.
      for (let attempt = 0; attempt < 3 && !etag; attempt++) {
        const res = await fetch(`/api/social/videos/${id}/parts/${part}`, {
          method: "PUT",
          headers: { [CSRF_HEADER]: csrf, "content-type": "application/octet-stream" },
          body: chunk,
        }).catch(() => null);
        const body = res ? await asJson(res) : {};
        if (res?.ok && typeof body.etag === "string") etag = body.etag;
        else if (res && res.status < 500 && res.status !== 400) throw failed(body, `The video did not upload (${res.status}).`);
      }
      if (!etag) throw new Error("The video upload kept failing. Check the connection and try again.");
      parts.push({ part, etag });
    }
    setStep(`${label} 100%`);
    const done = await fetch(`/api/social/videos/${id}/complete`, { method: "POST", headers: json, body: JSON.stringify({ parts }) });
    const body = await asJson(done);
    if (!done.ok) throw failed(body, `The video did not finish uploading (${done.status}).`);

    // Every video is edited on the server, edits or none, into an MP4 every channel takes.
    setStep(`${label.replace(/^Uploading/, "Editing").replace(/…$/, "")}… this can take a minute.`);
    const edited = await fetch(`/api/social/videos/${id}/edit`, { method: "POST", headers: json, body: JSON.stringify(editFor(item)) });
    const result = await asJson(edited);
    if (!edited.ok || typeof result.id !== "string") throw failed(result, `The video could not be edited (${edited.status}).`);
    return result.id;
  }

  async function post() {
    setError(null);
    setPosted(undefined);
    try {
      const ids: string[] = [];
      const videos = items.filter((i) => i.kind === "video").length;
      let v = 0;
      for (const [i, item] of items.entries()) {
        if (item.kind === "photo") {
          setStep(items.length > 1 ? `Preparing ${i + 1} of ${items.length}…` : "Preparing the photo…");
          ids.push(await uploadPhoto(item));
        } else {
          v++;
          ids.push(await uploadVideo(item, videos > 1 ? `Uploading video ${v} of ${videos}…` : "Uploading the video…"));
        }
      }
      setStep(
        videos && !facebook
          ? "Posting to Instagram… processing video can take a few minutes. Keep this page open."
          : `Posting to ${rules.name}…`,
      );
      const res = await fetch(rules.endpoint, {
        method: "POST",
        headers: { [CSRF_HEADER]: csrf, "content-type": "application/json" },
        body: JSON.stringify({
          caption,
          media: ids,
          // The cover is a frame of the kept part, counted from where it now starts.
          ...(reel && currentEdit
            ? { reel: { shareToFeed, coverMs: Math.max(0, Math.min(coverMs, currentEdit.endMs) - currentEdit.startMs) } }
            : {}),
        }),
      });
      const body = await asJson(res);
      if (!res.ok) throw failed(body, `${rules.name} did not take the post (${res.status}).`);
      items.forEach((p) => {
        URL.revokeObjectURL(p.url);
        urls.current.delete(p.url);
      });
      setItems([]);
      setEdits({});
      setCaption("");
      setShown(0);
      setCoverMs(0);
      setPosted(typeof body.permalink === "string" ? body.permalink : null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not post.");
    } finally {
      setStep(null);
    }
  }

  const longInCarousel =
    inCarousel && items.some((i) => i.kind === "video" && editFor(i).endMs - editFor(i).startMs > CAROUSEL_VIDEO_MAX_MS);
  const videoWithOthers = facebook && items.length > 1 && items.some((i) => i.kind === "video");
  const problem =
    items.length === 0 && !(facebook && caption.trim())
      ? facebook
        ? "Write something, or add photos or a video."
        : "Add a photo or video to post."
      : longInCarousel
        ? "A video in a carousel can be up to a minute long. Trim it, or post it on its own as a Reel."
        : videoWithOthers
          ? "On Facebook a video is posted on its own. Remove the other photos or videos, or post them separately."
          : caption.length > rules.textLimit
            ? `The text is over ${rules.textLimit.toLocaleString("en-CA")} characters.`
            : hashtags > rules.maxHashtags
              ? `Instagram allows ${rules.maxHashtags} hashtags; this has ${hashtags}.`
              : null;
  const postLabel = facebook ? "Post to Facebook" : reel ? "Post Reel" : items.length > 1 ? "Post carousel" : "Post";

  return (
    <div className="mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="grid content-start gap-4">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={picker}
              type="file"
              accept="image/*,video/mp4,video/quicktime,.mp4,.mov,.m4v"
              multiple
              hidden
              onChange={(e) => void add(e.target.files)}
            />
            <button type="button" disabled={busy || items.length >= MAX_ITEMS} onClick={() => picker.current?.click()} className={button}>
              {items.length ? "Add more" : "Add photos or videos"}
            </button>
            <span className="text-xs text-ink-faint">
              {facebook
                ? `Up to ${MAX_ITEMS} photos, or one video (MP4 or MOV, up to 300MB). Or just text.`
                : `One photo or video, or up to ${MAX_ITEMS} for a carousel. Video: MP4 or MOV, up to 300MB.`}
            </span>
          </div>
          {items.length ? (
            <ul className="flex flex-wrap gap-2">
              {items.map((p, i) => (
                <li key={p.id} className="grid w-24 gap-1">
                  <button
                    type="button"
                    onClick={() => setShown(i)}
                    aria-label={`Show ${p.kind} ${i + 1}`}
                    className={`relative overflow-hidden rounded-lg border ${i === shown ? "border-brand ring-2 ring-brand/40" : "border-line"}`}
                  >
                    {p.kind === "photo" ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a photo chosen on this device
                      <img src={p.url} alt="" style={{ aspectRatio: String(reel ? 9 / 16 : ratio) }} className="w-full object-cover" />
                    ) : (
                      <>
                        <video src={`${p.url}#t=0.5`} muted playsInline preload="metadata" style={{ aspectRatio: String(reel ? 9 / 16 : ratio) }} className="w-full bg-black object-cover" />
                        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-semibold text-white">
                          ▶ {seconds(p.durationMs ?? 0)}
                        </span>
                      </>
                    )}
                  </button>
                  <div className="flex justify-between text-xs">
                    <button type="button" disabled={busy || i === 0} onClick={() => move(p.id, -1)} aria-label="Move earlier" className="px-1 text-ink-soft hover:text-ink disabled:opacity-30">
                      ←
                    </button>
                    <button type="button" disabled={busy} onClick={() => remove(p.id)} className="px-1 text-ink-soft hover:text-bad">
                      Remove
                    </button>
                    <button type="button" disabled={busy || i === items.length - 1} onClick={() => move(p.id, 1)} aria-label="Move later" className="px-1 text-ink-soft hover:text-ink disabled:opacity-30">
                      →
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {current?.kind === "video" && currentEdit ? (
          <VideoEditor
            key={current.id}
            durationMs={current.durationMs ?? 0}
            edit={edits[current.id] ?? currentEdit}
            onChange={(next) => setEdits((e) => ({ ...e, [current.id]: next }))}
            shapes={inCarousel ? null : VIDEO_SHAPES[channel]}
            shapeFixed={inCarousel}
            disabled={busy}
          />
        ) : null}

        {facebook ? null : reel ? (
          <fieldset className="grid gap-3 rounded-xl border border-line p-3 text-sm" disabled={busy}>
            <legend className="px-1 font-medium text-ink">Reel</legend>
            <label className="grid gap-1.5">
              <span className="text-ink-soft">
                Cover: the frame at {clock(Math.max(coverMs, currentEdit?.startMs ?? 0))}
              </span>
              <input
                type="range"
                min={currentEdit?.startMs ?? 0}
                max={Math.max(0, (currentEdit?.endMs ?? reel.durationMs ?? 0) - 100)}
                step={100}
                value={Math.min(Math.max(coverMs, currentEdit?.startMs ?? 0), currentEdit?.endMs ?? coverMs)}
                onChange={(e) => setCoverMs(Number(e.target.value))}
                aria-label="Cover frame"
              />
            </label>
            <label className="flex items-center gap-2 text-ink">
              <input type="checkbox" checked={shareToFeed} onChange={(e) => setShareToFeed(e.target.checked)} />
              Also show it in the main feed and on the profile grid
            </label>
          </fieldset>
        ) : (
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
              Every photo in a post is cropped to one shape, from the centre; Instagram crops videos in a carousel to it too.
              {shape === "original" && items.length ? " Original keeps the first item’s shape, within what Instagram allows." : ""}
            </span>
          </fieldset>
        )}

        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-ink">{facebook ? "Text" : "Caption"}</span>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={7}
            disabled={busy}
            placeholder={facebook ? "What do you want to say?" : "Write a caption… #hashtags work here too"}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
          />
          <span className={`text-xs ${caption.length > rules.textLimit || hashtags > rules.maxHashtags ? "text-bad" : "text-ink-faint"}`}>
            {caption.length.toLocaleString("en-CA")} / {rules.textLimit.toLocaleString("en-CA")}
            {facebook ? "" : ` · ${hashtags} / ${rules.maxHashtags} hashtags`}
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void post()}
            disabled={busy || problem !== null}
            className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-50"
          >
            {busy ? "Posting…" : postLabel}
          </button>
          {step ? (
            <span role="status" className="text-sm text-ink-soft">
              {step}
            </span>
          ) : problem && items.length ? (
            <span className="text-sm text-ink-soft">{problem}</span>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {error}
          </p>
        ) : null}
        {posted !== undefined ? (
          <p role="status" className="rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
            Posted to {rules.name}.{" "}
            {posted ? (
              <a href={posted} target="_blank" rel="noreferrer" className="font-semibold underline">
                See it on {rules.name}
              </a>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="grid w-full max-w-[18rem] content-start gap-2 md:sticky md:top-4">
        <span className="text-sm font-medium text-ink">Preview{reel ? " · Reel" : ""}</span>
        <article className="overflow-hidden rounded-xl border border-line bg-white text-[13px] text-neutral-900 shadow-card">
          <header className="flex items-center gap-2 px-3 py-2.5">
            {picture ? (
              // eslint-disable-next-line @next/next/no-img-element -- the account's own picture
              <img src={picture} alt="" className="h-8 w-8 rounded-full object-cover" />
            ) : (
              <span
                className={`grid h-8 w-8 place-items-center rounded-full text-xs font-bold text-white ${facebook ? "bg-[#1877f2]" : "bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600"}`}
              >
                {username.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="grid leading-tight">
              <span className="font-semibold">{username}</span>
              {facebook ? <span className="text-[11px] text-neutral-500">Just now · 🌐</span> : null}
            </span>
          </header>
          {facebook ? (
            <p className="whitespace-pre-wrap break-words px-3 pb-2">
              {caption || <span className="text-neutral-400">What you write appears here</span>}
            </p>
          ) : null}
          {facebook && items.length === 0 ? null : (
          <div className="relative bg-neutral-900" style={{ aspectRatio: String(previewBox) }}>
            {current?.kind === "video" && currentEdit ? (
              <VideoPreview
                key={current.id}
                url={current.url}
                width={current.width}
                height={current.height}
                edit={currentEdit}
                box={previewBox}
                fit={reel && currentEdit.crop.ratio === null ? "contain" : "cover"}
                seekMs={reel ? Math.max(coverMs, currentEdit.startMs) : undefined}
              />
            ) : current ? (
              // eslint-disable-next-line @next/next/no-img-element -- a photo chosen on this device
              <img src={current.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <span className="absolute inset-0 grid place-items-center bg-neutral-100 text-neutral-400">Your photo or video</span>
            )}
            {items.length > 1 ? (
              <>
                <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
                  {Math.min(shown, items.length - 1) + 1}/{items.length}
                </span>
                <button type="button" aria-label="Previous" disabled={shown === 0} onClick={() => setShown((s) => Math.max(0, s - 1))} className="absolute left-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-neutral-800 shadow disabled:hidden">
                  ‹
                </button>
                <button type="button" aria-label="Next" disabled={shown >= items.length - 1} onClick={() => setShown((s) => Math.min(items.length - 1, s + 1))} className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-neutral-800 shadow disabled:hidden">
                  ›
                </button>
              </>
            ) : null}
          </div>
          )}
          {items.length > 1 ? (
            <div className="flex justify-center gap-1 pt-2">
              {items.map((p, i) => (
                <span key={p.id} className={`h-1.5 w-1.5 rounded-full ${i === Math.min(shown, items.length - 1) ? "bg-sky-500" : "bg-neutral-300"}`} />
              ))}
            </div>
          ) : null}
          {facebook ? (
            <div className="mt-2 flex justify-around border-t border-neutral-200 py-1.5 text-[12px] font-semibold text-neutral-500">
              <span>Like</span>
              <span>Comment</span>
              <span>Share</span>
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words px-3 pb-3 pt-2">
              <span className="font-semibold">{username}</span> {caption || <span className="text-neutral-400">Your caption</span>}
            </p>
          )}
        </article>
      </div>
    </div>
  );
}
