/**
 * A blog post Chat Boss proposed, as the chat shows it (app/chat/blog-draft-card.tsx).
 *
 * Plain and client-safe: the side panel builds these on the server, the
 * workspace in the browser, from the same receipt detail that
 * lib/workspace/blog-tools.ts writes.
 */

export type BlogDraftView = {
  receiptId: number | null;
  title: string;
  slug: string;
  excerpt: string;
  words: number;
  preview: string;
};

/** A receipt's detail as a card, or null when it is not a proposed post. */
export function blogDraftFrom(receipt: { id?: number; detail?: Record<string, unknown> | null }): BlogDraftView | null {
  const detail = receipt.detail;
  if (!detail || detail.blogDraft !== true || typeof detail.draft !== "object" || !detail.draft) return null;
  const d = detail.draft as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const body = str(d.body_html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return {
    receiptId: typeof receipt.id === "number" ? receipt.id : null,
    title: str(d.title),
    slug: str(d.slug),
    excerpt: str(d.meta_description) || str(d.excerpt),
    words: typeof detail.words === "number" ? detail.words : 0,
    preview: body.length > 360 ? `${body.slice(0, 360)}…` : body,
  };
}

