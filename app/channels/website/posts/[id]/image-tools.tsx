"use client";

import { useRef, useState } from "react";
import { CSRF_HEADER } from "@/lib/auth/csrf-names";

/**
 * Adding images to a blog post from the Website channel's editor.
 *
 * The file goes to /api/website/images, which passes it to the business's own
 * site to store; what comes back is where the site keeps it (`path`, the form
 * the post's featured image is saved in) and where it is served (`url`, what
 * goes into the body). Nothing is saved to the post until the person presses
 * Save: these only fill the form.
 */

type Uploaded = { path: string; url: string };

async function upload(file: File, csrf: string): Promise<Uploaded> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/website/images", { method: "POST", headers: { [CSRF_HEADER]: csrf }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `The upload failed (${res.status}).`);
  return body as Uploaded;
}

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,image/avif";
const button =
  "flex-none whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk disabled:opacity-60";

/** The featured image: its stored path, with an upload that fills it in. */
export function FeaturedImageField({
  defaultPath,
  readOnly,
  csrf,
  inputClassName,
}: {
  defaultPath: string;
  readOnly: boolean;
  csrf: string;
  inputClassName: string;
}) {
  const [path, setPath] = useState(defaultPath);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const done = await upload(file, csrf);
      setPath(done.path);
      setPreview(done.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  }

  return (
    <div className="grid gap-2">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- the site's own image host, shown as stored
        <img src={preview} alt="" className="aspect-video w-full rounded-lg border border-line object-cover" />
      ) : null}
      <input
        name="featured"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        readOnly={readOnly}
        placeholder="/wp-content/uploads/…"
        className={inputClassName}
      />
      {readOnly ? null : (
        <div className="flex items-center gap-2">
          <input ref={picker} type="file" accept={ACCEPT} hidden onChange={(e) => void choose(e.target.files?.[0])} />
          <button type="button" disabled={busy} onClick={() => picker.current?.click()} className={button}>
            {busy ? "Uploading…" : path ? "Replace image" : "Upload image"}
          </button>
          <span className="text-xs text-ink-faint">JPEG, PNG, WebP, GIF or AVIF, up to 8MB.</span>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Insert image" for the body: uploads the picture and puts an <img> where the
 * cursor is in the body's HTML, with the description as its alt text.
 */
export function InsertImage({ targetId, csrf }: { targetId: string; csrf: string }) {
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const { url } = await upload(file, csrf);
      const area = document.getElementById(targetId);
      if (!(area instanceof HTMLTextAreaElement)) throw new Error("The body could not be found on the page.");
      const text = alt.trim() || file.name.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ");
      const tag = `\n<img src="${url}" alt="${text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}" loading="lazy">\n`;
      const at = area.selectionStart ?? area.value.length;
      area.setRangeText(tag, at, area.selectionEnd ?? at, "end");
      area.focus();
      setAlt("");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={alt}
        onChange={(e) => setAlt(e.target.value)}
        placeholder="Describe the image (helps Google)"
        aria-label="Image description"
        maxLength={160}
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint"
      />
      <input ref={picker} type="file" accept={ACCEPT} hidden onChange={(e) => void choose(e.target.files?.[0])} />
      <button type="button" disabled={busy} onClick={() => picker.current?.click()} className={button}>
        {busy ? "Uploading…" : "Insert image"}
      </button>
      {done ? <span className="text-xs text-good">Added where the cursor was. Save to keep it.</span> : null}
      {error ? (
        <p role="alert" className="w-full text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
