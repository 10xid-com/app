import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePage } from "@/lib/auth/authorize";
import { organizationById } from "@/lib/db/identity";
import { websiteFor } from "@/lib/db/sites";
import { SiteError, siteRequest } from "@/lib/sites/client";
import { siteActorFor } from "@/lib/sites/website";
import { PortalShell } from "../../../portal-shell";

export const metadata: Metadata = { title: "Blog" };

/**
 * The website's blog: every post, newest first, read live from the site
 * (its /api/10xid/posts/). Editors and up only — the site answers nobody else.
 */

type Row = {
  id: number;
  slug: string;
  title: string;
  status: string;
  origin: string;
  seo_score: number | null;
  published_at: string | null;
  updated_at: string;
  author: string | null;
};

type List = { total: number; page: number; pages: number; posts: Row[] };

const STATUS_PILL: Record<string, string> = {
  published: "bg-good/10 text-good",
  draft: "bg-sunk text-ink-soft",
  scheduled: "bg-brand-soft text-brand",
  archived: "bg-sunk text-ink-faint",
};
const FILTERS = ["", "published", "draft", "scheduled", "archived"] as const;

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; p?: string; error?: string }>;
}) {
  const granted = await requirePage("pages.edit", { returnPath: "/channels/website/posts" });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const site = await websiteFor(owner);
  if (!site) redirect("/channels/website?error=notconnected");
  const business = await organizationById(granted.businessId);
  const params = await searchParams;

  const q = (params.q ?? "").slice(0, 100);
  const status = FILTERS.includes(params.status as (typeof FILTERS)[number]) ? (params.status ?? "") : "";
  const page = Math.max(1, Number(params.p) || 1);
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), p: String(page) });

  let data = null as List | null;
  let problem: string | null = null;
  try {
    const r = await siteRequest({
      siteUrl: site.siteUrl,
      actor: siteActorFor(granted, business?.name ?? ""),
      method: "GET",
      path: `/api/10xid/posts/?${query}`,
    });
    if (r.status === 200) data = r.body as unknown as List;
    else problem = typeof r.body.error === "string" ? r.body.error : `The site answered ${r.status}.`;
  } catch (err) {
    if (!(err instanceof SiteError)) throw err;
    problem = err.message;
  }

  const link = (over: Record<string, string>) => {
    const next = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...over });
    return `/channels/website/posts?${next}`;
  };

  return (
    <PortalShell email={granted.ctx.email} isStaff={granted.ctx.scope.isStaff} actingOn={null}>
      <Link href="/channels/website" className="text-sm text-ink-soft hover:text-ink">
        ← Website
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Blog</h1>
          <p className="mt-1 text-sm text-ink-soft">{site.siteUrl.replace("https://", "")}</p>
        </div>
        <Link
          href="/channels/website/posts/new"
          className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
        >
          New post
        </Link>
      </div>

      <form className="mt-5 flex flex-wrap gap-2" action="/channels/website/posts">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search posts"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
        />
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <button type="submit" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-sunk">
          Search
        </button>
      </form>
      <nav aria-label="Filter by status" className="mt-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f || "all"}
            href={link({ status: f, p: "1" })}
            aria-current={f === status ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              f === status ? "bg-ink text-ground" : "bg-sunk text-ink-soft hover:text-ink"
            }`}
          >
            {f ? f[0].toUpperCase() + f.slice(1) : "All"}
          </Link>
        ))}
      </nav>

      {params.error === "draft" ? (
        <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          That Chat Boss draft could not be found. Drafts can only be saved by the person who asked for them.
        </p>
      ) : null}

      {problem ? (
        <p role="alert" className="mt-6 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          The site did not answer: {problem}
        </p>
      ) : data ? (
        <>
          <ul className="mt-5 divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {data.posts.length === 0 ? <li className="px-4 py-6 text-center text-sm text-ink-faint">No posts match.</li> : null}
            {data.posts.map((p) => (
              <li key={p.id}>
                <Link href={`/channels/website/posts/${p.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-sunk">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{p.title}</span>
                    <span className="block truncate text-xs text-ink-faint">
                      /{p.slug}/ · {p.author ?? "No author"} · {(p.published_at ?? p.updated_at).slice(0, 10)}
                    </span>
                  </span>
                  {p.seo_score !== null ? (
                    <span className="text-xs tabular-nums text-ink-faint" title="SEO score">
                      SEO {p.seo_score}
                    </span>
                  ) : null}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[p.status] ?? "bg-sunk text-ink-soft"}`}>
                    {p.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
            <span>
              {data.total} {data.total === 1 ? "post" : "posts"}
            </span>
            <span className="flex gap-3">
              {data.page > 1 ? <Link href={link({ p: String(data.page - 1) })}>← Newer</Link> : null}
              <span>
                Page {data.page} of {data.pages}
              </span>
              {data.page < data.pages ? <Link href={link({ p: String(data.page + 1) })}>Older →</Link> : null}
            </span>
          </div>
        </>
      ) : null}
    </PortalShell>
  );
}
