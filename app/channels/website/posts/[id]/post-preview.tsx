"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * What the post will look like, beside the fields that make it.
 *
 * "Live" redraws as the person types, uploads or inserts an image: the post's
 * hero (title on the site's navy beside the featured image), then the body,
 * in the site's own fonts. It is a sketch of the page, not the page — the
 * sidebar, the offer and the header are left out — and it is drawn from the
 * form, so it shows what is typed, saved or not.
 *
 * "On the site" is the page itself: the last saved version, drawn by the
 * website (/api/website/posts/[id]/preview), draft or not.
 *
 * Both are sandboxed frames with no scripts, so nothing typed into the body
 * runs in the portal.
 */

/** Sent by the image tools after they change a field without typing in it. */
export const PREVIEW_REFRESH = "post-preview:refresh";

export type Fields = { title: string; body: string; featured: string; author: string; date: string };

function read(form: HTMLFormElement): Fields {
  // By element as well as name: a read-only post repeats some fields as hidden inputs.
  const value = (selector: string) =>
    form.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value ?? "";
  const author = form.querySelector<HTMLSelectElement>('select[name="author_id"]');
  return {
    title: value('input[name="title"]'),
    body: value('textarea[name="body_html"]'),
    featured: value('input[name="featured"]').trim(),
    author: author?.value ? (author.selectedOptions[0]?.text ?? "") : "",
    date: value('input[name="published_at"]'),
  };
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A stored image path as an address: the site serves /wp-content/uploads itself, or redirects to its image host. */
export function imageAddress(path: string, siteUrl: string): string | null {
  if (!path) return null;
  if (/^https:\/\//i.test(path)) return path;
  if (path.startsWith("/") && !path.startsWith("//")) return `${siteUrl}${path}`;
  return null;
}

function dateLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
}

export function sketch(f: Fields, siteUrl: string): string {
  const image = imageAddress(f.featured, siteUrl);
  const byline = [f.author, dateLabel(f.date)].filter(Boolean).map(escape).join(" &middot; ");
  return `<!doctype html><html><head><meta charset="utf-8">
<base href="${escape(siteUrl)}/" target="_blank">
<link rel="stylesheet" href="/fonts/poppins.css">
<style>
  body { margin: 0; color: #444; font: 300 17px/1.5 "Poppins", system-ui, sans-serif; background: #fff; }
  .hero { display: flex; flex-wrap: wrap; }
  .hero h1 { flex: 1 1 260px; margin: 0; padding: 32px 20px; display: flex; align-items: center; justify-content: center;
    background: #15334c; color: #fff; text-align: center; font: 600 28px/1.2 "Poppins", system-ui, sans-serif; }
  .hero figure { flex: 1 1 260px; margin: 0; min-height: 180px; background: #eee; }
  .hero img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .byline { margin: 14px 20px 0; font-size: 13px; color: #888; }
  .body { padding: 8px 20px 40px; max-width: 760px; }
  .body img { max-width: 100%; height: auto; border-radius: 4px; }
  .body h2, .body h3 { color: #15334c; font-weight: 600; line-height: 1.25; }
  .body a { color: #e4007c; }
  .empty { color: #aaa; font-style: italic; }
</style></head><body>
<div class="hero"><h1>${escape(f.title) || '<span class="empty">Title</span>'}</h1>${
    image ? `<figure><img src="${escape(image)}" alt=""></figure>` : ""
  }</div>
${byline ? `<p class="byline">${byline}</p>` : ""}
<div class="body">${f.body.trim() ? f.body : '<p class="empty">The body appears here as you write it.</p>'}</div>
</body></html>`;
}

const tab = "rounded-md px-3 py-1 text-[13px] font-semibold";

export function PostPreview({ siteUrl, postId }: { siteUrl: string; postId: number | null }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"live" | "site">("live");
  const [doc, setDoc] = useState("");
  // Bumped to fetch the saved page again.
  const [loadCount, setLoadCount] = useState(0);

  const redraw = useCallback(() => {
    const form = anchor.current?.closest("form");
    if (form) setDoc(sketch(read(form), siteUrl));
  }, [siteUrl]);

  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After React has applied a change the image tools made, and not on every keystroke.
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(redraw, 200);
    };
    redraw();
    form.addEventListener("input", soon);
    form.addEventListener("change", soon);
    form.addEventListener(PREVIEW_REFRESH, soon);
    return () => {
      clearTimeout(timer);
      form.removeEventListener("input", soon);
      form.removeEventListener("change", soon);
      form.removeEventListener(PREVIEW_REFRESH, soon);
    };
  }, [redraw]);

  return (
    <div ref={anchor} className="grid gap-2 rounded-xl border border-line bg-surface p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm font-medium text-ink">Preview</span>
        <div role="tablist" className="flex gap-1 rounded-lg bg-sunk p-0.5">
          <button type="button" role="tab" aria-selected={mode === "live"} onClick={() => setMode("live")}
            className={`${tab} ${mode === "live" ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink"}`}>
            Live
          </button>
          <button type="button" role="tab" aria-selected={mode === "site"} disabled={postId === null}
            title={postId === null ? "Save the draft first" : undefined}
            onClick={() => { setMode("site"); setLoadCount((n) => n + 1); }}
            className={`${tab} ${mode === "site" ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink"} disabled:opacity-50`}>
            On the site
          </button>
        </div>
      </div>
      {mode === "live" ? (
        <iframe title="Live preview of the post" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} className="h-[34rem] w-full rounded-lg border border-line bg-white" />
      ) : (
        <iframe
          key={loadCount}
          title="The post as the website draws it"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          src={`/api/website/posts/${postId}/preview`}
          className="h-[44rem] w-full rounded-lg border border-line bg-white"
        />
      )}
      <p className="flex flex-wrap items-center gap-x-3 text-xs text-ink-faint">
        {mode === "live" ? (
          <>Updates as you type. A sketch of the page; “On the site” shows it exactly.</>
        ) : (
          <>
            The last saved version, exactly as the website will show it. Save to see new changes.
            <button type="button" onClick={() => setLoadCount((n) => n + 1)} className="underline hover:text-ink">
              Reload
            </button>
            <a href={`/api/website/posts/${postId}/preview`} target="_blank" rel="noreferrer" className="underline hover:text-ink">
              Open full size
            </a>
          </>
        )}
      </p>
    </div>
  );
}
