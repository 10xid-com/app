import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { connectedChannels } from "@/lib/db/channels";
import { organizationById } from "@/lib/db/identity";
import { websiteFor } from "@/lib/db/sites";
import { SiteError, siteRequest } from "@/lib/sites/client";
import { siteActorFor } from "@/lib/sites/website";
import { PortalShell } from "../portal-shell";
import { Icon } from "../_components/icons";
import { CHANNELS } from "../_components/sections";

export const metadata: Metadata = { title: "Content" };

type Status = { posts: { all: number; published: number; draft: number; scheduled: number; archived: number } };
type Post = { id: number; title: string; status: string; updated_at: string };

const STATUS_PILL: Record<string, string> = {
  published: "bg-good/10 text-good",
  draft: "bg-sunk text-ink-soft",
  scheduled: "bg-brand-soft text-brand",
  archived: "bg-sunk text-ink-faint",
};

/**
 * Everything the business publishes, in one place: the website's blog, read
 * live from the site as on its own screens, and the social accounts it posts
 * to. The site answers editors and up, as it does on /channels/website/posts.
 */
export default async function ContentPage() {
  const granted = await requirePage("business.view", { returnPath: "/content" });
  const { ctx, businessId, role, via } = granted;
  const owner = { organizationId: businessId, userId: ctx.userId };

  const [site, channels, business] = await Promise.all([
    websiteFor(owner),
    connectedChannels(owner),
    organizationById(businessId),
  ]);
  const mayEditPages = allows(role, "pages.edit", via);
  const social = (["instagram", "facebook"] as const).filter((c) => channels.has(c));

  let status: Status | null = null;
  let posts: Post[] = [];
  let problem: string | null = null;
  if (site && mayEditPages) {
    const actor = siteActorFor(granted, business?.name ?? "");
    try {
      const [s, p] = await Promise.all([
        siteRequest({ siteUrl: site.siteUrl, actor, method: "GET", path: "/api/10xid/status/" }),
        siteRequest({ siteUrl: site.siteUrl, actor, method: "GET", path: "/api/10xid/posts/?p=1" }),
      ]);
      if (s.status === 200) status = s.body as unknown as Status;
      if (p.status === 200) posts = ((p.body.posts as Post[] | undefined) ?? []).slice(0, 5);
      if (s.status !== 200) problem = typeof s.body.error === "string" ? s.body.error : `The site answered ${s.status}.`;
    } catch (err) {
      if (!(err instanceof SiteError)) throw err;
      problem = err.message;
    }
  }

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Content</h1>
      <p className="mt-1 text-sm text-ink-soft">Your blog and the accounts you post to, in one place.</p>

      {!site && social.length === 0 ? (
        <div className="mt-6 rounded-xl border border-line bg-surface p-8 text-center shadow-card">
          <p className="text-sm text-ink">Nothing to publish to yet.</p>
          <p className="mt-1 text-sm text-ink-soft">Connect your website, Instagram or Facebook, and their content is gathered here.</p>
          <Link
            href="/channels"
            className="mt-4 inline-block rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
          >
            Connect a channel
          </Link>
        </div>
      ) : null}

      {site ? (
        <section className="mt-6 rounded-xl border border-line bg-surface shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
            <div className="flex items-center gap-2">
              <Icon name="website" className="h-[18px] w-[18px] text-ink-soft" />
              <h2 className="text-sm font-semibold text-ink">Blog</h2>
              <span className="text-xs text-ink-faint">{site.siteUrl.replace("https://", "")}</span>
            </div>
            {mayEditPages ? (
              <div className="flex gap-2">
                <Link href="/channels/website/posts" className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-sunk">
                  All posts
                </Link>
                <Link
                  href="/channels/website/posts/new"
                  className="rounded-lg bg-brand-surface px-3 py-1.5 text-xs font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
                >
                  New post
                </Link>
              </div>
            ) : null}
          </div>

          {!mayEditPages ? (
            <p className="px-5 pb-5 pt-3 text-sm text-ink-soft">Editors, publishers, managers and owners work on the blog.</p>
          ) : problem ? (
            <p role="alert" className="mx-5 mb-5 mt-3 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
              The website did not answer: {problem}
            </p>
          ) : (
            <>
              {status ? (
                <dl className="mt-4 grid grid-cols-2 gap-3 px-5 sm:grid-cols-4">
                  {(["published", "draft", "scheduled", "all"] as const).map((k) => (
                    <div key={k} className="rounded-lg bg-sunk px-3 py-2">
                      <dt className="text-xs capitalize text-ink-faint">{k === "all" ? "All posts" : k}</dt>
                      <dd className="text-lg font-semibold tabular-nums text-ink">{status.posts[k]}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <ul className="mt-3 divide-y divide-line-soft border-t border-line-soft">
                {posts.length === 0 ? (
                  <li className="px-5 py-6 text-center text-sm text-ink-faint">No posts yet.</li>
                ) : (
                  posts.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/channels/website/posts/${p.id}`}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-sunk"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.title || "Untitled"}</span>
                        <span className={`flex-none rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[p.status] ?? "bg-sunk text-ink-soft"}`}>
                          {p.status}
                        </span>
                        <span className="w-24 flex-none text-right text-xs tabular-nums text-ink-faint">
                          {new Date(p.updated_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
                        </span>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {social.length > 0 ? (
        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          {social.map((c) => (
            <Link
              key={c}
              href={CHANNELS[c].href}
              className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:bg-sunk"
            >
              <Icon name={CHANNELS[c].icon} className="mt-0.5 h-5 w-5 flex-none text-ink-soft" />
              <span>
                <span className="block text-sm font-semibold text-ink">{CHANNELS[c].label}</span>
                <span className="block text-sm text-ink-soft">Post, and see your latest posts and how they did.</span>
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      {site || social.length > 0 ? (
        <p className="mt-6 text-sm text-ink-soft">
          Something else to publish to? <Link href="/channels" className="text-brand underline underline-offset-2">Add a channel</Link>.
        </p>
      ) : null}
    </PortalShell>
  );
}
