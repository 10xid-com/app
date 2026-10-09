import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { organizationById } from "@/lib/db/identity";
import { websiteFor } from "@/lib/db/sites";
import { SiteError, siteRequest } from "@/lib/sites/client";
import { formWithDraft, isLiveStatus, siteActorFor } from "@/lib/sites/website";
import { getBlogDraftReceipt } from "@/lib/db/workspace";
import { blogDraftSchema } from "@/lib/workspace/blog-tools";
import { PortalShell } from "../../../../portal-shell";
import { CsrfField } from "../../../../_components/csrf-field";
import { savePostAction } from "../../actions";
import { SubmitButton } from "../../../../_components/submit-button";
import { FeaturedImageField, InsertImage } from "./image-tools";
import { resolveIdentity } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Post" };

/**
 * One post, or a new one, edited here and saved through the site's own save
 * route (app/channels/website/actions.ts).
 *
 * The site sends the post as the exact form its save route reads, and that
 * route replaces every column — a field left out is a field cleared. So every
 * field this screen does not show goes back as a hidden input, unchanged.
 *
 * An imported post's page is built from the original site's layout (galleries,
 * before/after sliders), which a saved body would rebuild from the text alone.
 * Its body is read-only until the person chooses to rebuild it, and says why.
 *
 * Editors draft. A live post, and making one live, is a publisher's.
 */

type SiteForm = Record<string, string | string[]>;
type Loaded = {
  id: number | null;
  origin: string;
  seoScore: number | null;
  address: string | null;
  form: SiteForm;
  options: { authors: { id: number; name: string }[]; categories: { id: number; name: string }[]; brands: { id: number; name: string }[] };
};

/** Shown on screen; everything else in the site's form travels hidden. */
const SHOWN = new Set([
  "title", "slug", "status", "published_at", "author_id", "excerpt", "body_html", "featured",
  "term", "tag", "seo_title", "meta_description", "focus_keyword", "robots_index",
]);

const input = "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; detail?: string; done?: string; relayout?: string; from?: string }>;
}) {
  const { id } = await params;
  if (id !== "new" && !/^\d{1,9}$/.test(id)) notFound();
  const granted = await requirePage("pages.edit", { returnPath: `/channels/website/posts/${id}` });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const site = await websiteFor(owner);
  if (!site) redirect("/channels/website?error=notconnected");
  const business = await organizationById(granted.businessId);
  const query = await searchParams;
  const mayPublish = allows(granted.role, "pages.publish", granted.via);
  // For the image uploads, which go to /api/website/images from the browser.
  const identity = await resolveIdentity();
  const csrf = identity.state === "active" ? identity.csrfToken : "";

  let post: Loaded | null = null;
  let problem: string | null = null;
  try {
    const r = await siteRequest({
      siteUrl: site.siteUrl,
      actor: siteActorFor(granted, business?.name ?? ""),
      method: "GET",
      path: `/api/10xid/posts/${id}/`,
    });
    if (r.status === 404) notFound();
    if (r.status === 200) post = r.body as unknown as Loaded;
    else problem = typeof r.body.error === "string" ? r.body.error : `The site answered ${r.status}.`;
  } catch (err) {
    if (!(err instanceof SiteError)) throw err;
    problem = err.message;
  }

  // A post Chat Boss proposed, opened from its card: this person's own
  // proposal, laid over the new-post defaults, for them to review and save.
  let fromChat = false;
  if (post && id === "new" && query.from) {
    const receipt = await getBlogDraftReceipt(owner, Number(query.from));
    const draft = receipt ? blogDraftSchema.safeParse(receipt.detail.draft) : null;
    if (draft?.success) {
      post = { ...post, form: formWithDraft(post.form, draft.data) };
      fromChat = true;
    }
  }

  const f = post?.form ?? {};
  const isNew = id === "new";
  const live = !isNew && isLiveStatus(one(f.status));
  const readOnly = live && !mayPublish;
  const imported = post?.origin === "imported";
  const relayout = imported && query.relayout === "1";
  const chosen = new Set(many(f.term));
  const hidden = Object.entries(f).filter(([k]) => !SHOWN.has(k));

  return (
    <PortalShell email={granted.ctx.email} isStaff={granted.ctx.scope.isStaff} actingOn={null}>
      <Link href="/channels/website/posts" className="text-sm text-ink-soft hover:text-ink">
        ← Blog
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{isNew ? "New post" : one(f.title) || "Post"}</h1>
        {post?.address && !isNew ? (
          <a href={post.address} target="_blank" rel="noreferrer" className="text-sm text-ink-soft underline hover:text-ink">
            View on the site
          </a>
        ) : null}
      </div>

      {query.error ? (
        <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {query.error === "publish"
            ? "Your role can save drafts. A publisher, manager or owner makes a post live."
            : (query.detail ?? "The site refused that.")}
        </p>
      ) : null}
      {fromChat ? (
        <p role="status" className="mt-4 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-sm text-ink">
          Written with Chat Boss. Read it through, change anything you like, then save it as a draft.
        </p>
      ) : null}
      {query.done === "saved" ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          Saved{post?.seoScore !== null && post?.seoScore !== undefined ? ` — SEO score ${post.seoScore}` : ""}. It goes live on the site the next time
          the website is published.
        </p>
      ) : null}

      {problem ? (
        <p role="alert" className="mt-6 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          The site did not answer: {problem}
        </p>
      ) : post ? (
        <form action={savePostAction} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <CsrfField />
          {hidden.flatMap(([k, v]) => many(v).map((value, i) => <input key={`${k}-${i}`} type="hidden" name={k} value={value} />))}
          {relayout ? <input type="hidden" name="relayout" value="1" /> : null}

          <div className="grid content-start gap-4">
            {readOnly ? (
              <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink">
                This post is live. Your role can read it here; a publisher, manager or owner can change it.
              </p>
            ) : null}
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-ink">Title</span>
              <input name="title" required maxLength={200} defaultValue={one(f.title)} readOnly={readOnly} className={`${input} text-base`} />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-ink">Permalink</span>
              <span className="flex items-center gap-1 text-ink-faint">
                {site.siteUrl.replace("https://", "")}/
                <input
                  name="slug"
                  required
                  maxLength={180}
                  pattern="[a-z0-9][a-z0-9\-/]*"
                  title="Lowercase letters, digits, hyphens and slashes"
                  defaultValue={one(f.slug)}
                  readOnly={readOnly}
                  className={`${input} min-w-0 flex-1`}
                />
                /
              </span>
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-ink">Body (HTML)</span>
              <textarea
                id="post-body"
                name="body_html"
                rows={18}
                defaultValue={one(f.body_html)}
                readOnly={readOnly || (imported && !relayout)}
                className={`${input} font-mono text-[13px] leading-relaxed`}
              />
              {imported && !relayout && !readOnly ? (
                <span className="text-xs text-ink-soft">
                  This post came from the old site and its page keeps that layout — galleries, before/after sliders, the
                  sidebar. Editing the text rebuilds the page from the text alone.{" "}
                  <Link href="?relayout=1" className="underline">
                    Edit the text anyway
                  </Link>
                </span>
              ) : null}
              {relayout ? (
                <span className="text-xs text-warn">Saving rebuilds this post’s page from the text. Its original layout is replaced.</span>
              ) : null}
            </label>
            {readOnly || (imported && !relayout) ? null : <InsertImage targetId="post-body" csrf={csrf} />}
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-ink">Excerpt</span>
              <textarea name="excerpt" rows={3} maxLength={320} defaultValue={one(f.excerpt)} readOnly={readOnly} placeholder="Left blank, the first sentences are used." className={input} />
            </label>

            <fieldset className="grid gap-3 rounded-xl border border-line p-4">
              <legend className="px-1 text-sm font-semibold text-ink">Search engines</legend>
              <label className="grid gap-1.5 text-sm">
                <span className="text-ink-soft">SEO title</span>
                <input name="seo_title" maxLength={200} defaultValue={one(f.seo_title)} readOnly={readOnly} placeholder="Falls back to the title" className={input} />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="text-ink-soft">Meta description</span>
                <textarea name="meta_description" rows={2} maxLength={320} defaultValue={one(f.meta_description)} readOnly={readOnly} placeholder="Falls back to the excerpt" className={input} />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="text-ink-soft">Focus keyword</span>
                <input name="focus_keyword" maxLength={120} defaultValue={one(f.focus_keyword)} readOnly={readOnly} className={input} />
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name="robots_index" value="1" defaultChecked={one(f.robots_index) !== ""} disabled={readOnly} />
                Show this post in search results
              </label>
              {readOnly && one(f.robots_index) !== "" ? <input type="hidden" name="robots_index" value="1" /> : null}
            </fieldset>
          </div>

          <aside className="grid content-start gap-4">
            <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 shadow-card">
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-ink">Status</span>
                {mayPublish ? (
                  <select name="status" defaultValue={one(f.status) || "draft"} className={input}>
                    <option value="draft">Draft</option>
                    <option value="published">Published</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="archived">Archived</option>
                  </select>
                ) : (
                  <>
                    <input type="hidden" name="status" value={live ? one(f.status) : "draft"} />
                    <span className="text-ink-soft">{live ? one(f.status) : "Draft"}</span>
                  </>
                )}
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-ink">Publish date</span>
                <input type="date" name="published_at" defaultValue={one(f.published_at)} readOnly={readOnly} className={input} />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-ink">Author</span>
                <select name="author_id" defaultValue={one(f.author_id)} disabled={readOnly} className={input}>
                  <option value="">None</option>
                  {post.options.authors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {readOnly ? <input type="hidden" name="author_id" value={one(f.author_id)} /> : null}
              </label>
              {readOnly ? null : (
                <SubmitButton
                  pendingLabel="Saving…"
                  className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-60"
                >
                  {isNew ? "Save draft" : "Save"}
                </SubmitButton>
              )}
              <p className="text-xs text-ink-faint">Saved posts go live when the website is published.</p>
            </div>

            <div className="grid gap-1.5 rounded-xl border border-line bg-surface p-4 text-sm shadow-card">
              <span className="font-medium text-ink">Featured image</span>
              <FeaturedImageField defaultPath={one(f.featured)} readOnly={readOnly} csrf={csrf} inputClassName={input} />
            </div>

            <fieldset className="grid gap-2 rounded-xl border border-line bg-surface p-4 text-sm shadow-card" disabled={readOnly}>
              <legend className="px-1 font-medium text-ink">Categories</legend>
              <div className="grid max-h-56 gap-1 overflow-y-auto">
                {post.options.categories.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-ink">
                    <input type="checkbox" name="term" value={String(c.id)} defaultChecked={chosen.has(String(c.id))} />
                    {c.name}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="grid gap-1.5 rounded-xl border border-line bg-surface p-4 text-sm shadow-card">
              <span className="font-medium text-ink">Vehicle brands</span>
              <select name="term" multiple size={8} defaultValue={many(f.term).filter((t) => post!.options.brands.some((b) => String(b.id) === t))} disabled={readOnly} className={input}>
                {post.options.brands.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-faint">Hold Ctrl or ⌘ to pick several.</span>
            </label>

            <label className="grid gap-1.5 rounded-xl border border-line bg-surface p-4 text-sm shadow-card">
              <span className="font-medium text-ink">Tags</span>
              <input name="tags_csv" defaultValue={many(f.tag).join(", ")} readOnly={readOnly} placeholder="Comma, separated" className={input} />
            </label>

            {readOnly ? many(f.term).map((t) => <input key={`t-${t}`} type="hidden" name="term" value={t} />) : null}
          </aside>
        </form>
      ) : null}
    </PortalShell>
  );
}
