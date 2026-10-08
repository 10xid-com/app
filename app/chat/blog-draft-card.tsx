"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { saveBlogDraftFromChatAction } from "../channels/website/actions";
import { CsrfInput } from "./csrf";
import type { BlogDraftView } from "@/lib/workspace/blog-draft";

/**
 * A blog post Chat Boss proposed, as a card under the answer that proposed it.
 *
 * Nothing has been saved when this appears (lib/workspace/blog-tools.ts). The
 * person saves it as a draft, or opens it in the Website editor to change it
 * first. Both name only the receipt: the post is read back from it on the
 * server, so what is saved is what is shown here.
 *
 * The body is shown as text, never as markup: it is model output.
 */

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-brand-surface px-3 py-1.5 text-[13px] font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save as draft"}
    </button>
  );
}

export function BlogDraftCard({ draft }: { draft: BlogDraftView }) {
  return (
    <div className="overflow-hidden rounded-xl border border-brand/30 bg-surface shadow-card">
      <div className="border-b border-line-soft bg-brand-soft px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-brand">
        Blog post draft · not saved yet
      </div>
      <div className="px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">{draft.title}</p>
        <p className="mt-0.5 truncate text-xs text-ink-faint">
          /{draft.slug}/ · {draft.words} words
        </p>
        {draft.excerpt ? <p className="mt-2 text-sm text-ink-soft">{draft.excerpt}</p> : null}
        {draft.preview ? <p className="mt-2 line-clamp-4 text-[13px] leading-relaxed text-ink-faint">{draft.preview}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-2.5">
        {draft.receiptId !== null ? (
          <>
            <form action={saveBlogDraftFromChatAction}>
              <CsrfInput />
              <input type="hidden" name="receiptId" value={draft.receiptId} />
              <SaveButton />
            </form>
            <Link
              href={`/channels/website/posts/new?from=${draft.receiptId}`}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk"
            >
              Review in editor
            </Link>
          </>
        ) : (
          <span className="text-xs text-ink-faint">Finishing the answer…</span>
        )}
        <span className="ml-auto text-[11px] text-ink-faint">Saved as a draft. Publishing is separate.</span>
      </div>
    </div>
  );
}
