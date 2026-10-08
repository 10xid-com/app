import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { organizationById } from "@/lib/db/identity";
import { listLinkedRepositories } from "@/lib/db/repositories";
import { websiteFor } from "@/lib/db/sites";
import { SiteError, siteRequest, siteSigningConfigured } from "@/lib/sites/client";
import { siteActorFor } from "@/lib/sites/website";
import { PortalShell } from "../../portal-shell";
import { CsrfField } from "../../_components/csrf-field";
import { Icon } from "../../_components/icons";
import { connectWebsiteAction, disconnectWebsiteAction, publishWebsiteAction } from "./actions";
import { RefreshWhileRunning } from "./refresh";
import { SitePreview } from "../../_components/site-preview";

export const metadata: Metadata = { title: "Website" };

/**
 * The Website channel: the business's site, run from here.
 *
 * Not connected, an owner connects it (domains.manage). Connected, the card
 * says whether the site answers the portal, what is on it and how the last
 * publish went; editors and publishers go on to the blog, and publishers
 * publish. Everything about the site is read live from the site itself, over
 * a signed request (lib/sites/), so this page never shows a copy that has
 * drifted.
 */

const ERRORS: Record<string, string> = {
  url: "Enter the site's address, like astro.example.com. It has to be a public https site.",
  repo: "That repository is not linked to this business.",
  connected: "A website is already connected. Disconnect it first.",
  taken: "That site is already connected to another business.",
  notconnected: "Connect the website first.",
};
const DONE: Record<string, string> = {
  connected: "Website connected.",
  disconnected: "Website disconnected. Nothing on the site was changed.",
  published: "Publishing started. The site rebuilds and goes live in a few minutes.",
};

type Status = {
  posts: { all: number; published: number; draft: number; scheduled: number; archived: number };
  publishing: boolean;
};
type Run = { status: string; conclusion: string | null; startedAt: string; url: string } | null;

export default async function WebsitePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string; done?: string }>;
}) {
  const granted = await requirePage("business.view", { returnPath: "/channels/website" });
  const { ctx, businessId, role, via } = granted;
  const owner = { organizationId: businessId, userId: ctx.userId };
  const params = await searchParams;

  const [site, business] = await Promise.all([websiteFor(owner), organizationById(businessId)]);
  const mayConnect = allows(role, "domains.manage", via);
  const mayEdit = allows(role, "pages.edit", via);
  const mayPublish = allows(role, "pages.publish", via);
  const repositories = mayConnect && !site ? await listLinkedRepositories(owner) : [];
  const signing = siteSigningConfigured();

  // What the site says about itself. Only for people who may edit: the site
  // answers nobody else.
  let status: Status | null = null;
  let run: Run = null;
  let problem: string | null = null;
  if (site && mayEdit && signing) {
    const actor = siteActorFor(granted, business?.name ?? "");
    try {
      const [s, d] = await Promise.all([
        siteRequest({ siteUrl: site.siteUrl, actor, method: "GET", path: "/api/10xid/status/" }),
        siteRequest({ siteUrl: site.siteUrl, actor, method: "GET", path: "/api/10xid/deploy/" }),
      ]);
      if (s.status === 200) status = s.body as unknown as Status;
      else problem = typeof s.body.error === "string" ? s.body.error : `The site answered ${s.status}.`;
      if (d.status === 200) run = (d.body.run as Run) ?? null;
    } catch (err) {
      if (!(err instanceof SiteError)) throw err;
      problem = err.message;
    }
  }
  const running = run !== null && run.status !== "completed";

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Website</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        Write and publish your website’s blog from here. Pages and landing pages come next.
      </p>

      {params.error ? (
        <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {params.error === "site" ? (params.detail ?? "The site refused that.") : (ERRORS[params.error] ?? "That did not work.")}
        </p>
      ) : null}
      {params.done && DONE[params.done] ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          {DONE[params.done]}
        </p>
      ) : null}

      {!site ? (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-card">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-sunk text-ink-soft">
              <Icon name="website" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-ink">Connect your website</h2>
              <p className="text-sm text-ink-soft">
                Once it is connected, your team can write posts here and publish them to the site.
              </p>
            </div>
          </div>

          {mayConnect ? (
            <form action={connectWebsiteAction} className="mt-5 grid gap-4 sm:max-w-md">
              <CsrfField />
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-ink">Site address</span>
                <input
                  name="siteUrl"
                  required
                  placeholder="astro.example.com"
                  autoComplete="off"
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-faint"
                />
              </label>
              {repositories.length ? (
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium text-ink">Repository it is built from (optional)</span>
                  <select name="repositoryId" className="rounded-lg border border-line bg-surface px-3 py-2 text-ink">
                    <option value="">None</option>
                    {repositories.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.owner}/{r.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div>
                <button type="submit" className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover">
                  Connect website
                </button>
              </div>
            </form>
          ) : (
            <p className="mt-4 text-sm text-ink-soft">Only an owner of the business can connect its website.</p>
          )}
        </section>
      ) : (
        <>
          <section className="mt-6 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-4">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-sunk text-ink-soft">
                <Icon name="website" />
              </span>
              <div className="min-w-0 flex-1">
                <a href={site.siteUrl} target="_blank" rel="noreferrer" className="block truncate text-base font-semibold text-ink hover:underline">
                  {site.siteUrl.replace("https://", "")}
                </a>
                <p className="text-xs text-ink-faint">Connected {site.connectedAt.toISOString().slice(0, 10)}</p>
              </div>
              {mayPublish && status ? (
                <form action={publishWebsiteAction}>
                  <CsrfField />
                  <button
                    type="submit"
                    disabled={running || !status.publishing}
                    className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-50"
                  >
                    {running ? "Publishing…" : "Publish"}
                  </button>
                </form>
              ) : null}
            </div>

            <SitePreview url={site.siteUrl} />

            <div className="border-t border-line-soft px-5 py-4 text-sm">
              {!mayEdit ? (
                <p className="text-ink-soft">Your role can see that the website is connected. Editors and publishers work on it here.</p>
              ) : !signing ? (
                <p className="text-warn">The portal is not set up to talk to websites yet (its signing key is missing).</p>
              ) : problem ? (
                <p className="text-bad">The site did not answer the portal: {problem}</p>
              ) : status ? (
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {(
                    [
                      ["Published posts", status.posts.published],
                      ["Drafts", status.posts.draft],
                      ["Scheduled", status.posts.scheduled],
                      ["All posts", status.posts.all],
                    ] as const
                  ).map(([label, n]) => (
                    <div key={label} className="rounded-lg bg-sunk px-3 py-2">
                      <dt className="text-xs text-ink-faint">{label}</dt>
                      <dd className="text-lg font-semibold tabular-nums text-ink">{n}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {status && !status.publishing ? (
                <p className="mt-3 text-warn">Publishing is not wired up on the site yet (it needs its deploy token).</p>
              ) : null}

              {run ? (
                <p className="mt-3 flex flex-wrap items-center gap-2 text-ink-soft">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      running ? "bg-warn" : run.conclusion === "success" ? "bg-good" : "bg-bad"
                    }`}
                  />
                  Last publish: {running ? "building now" : run.conclusion === "success" ? "live" : (run.conclusion ?? "ended")}
                  {" · "}
                  {new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
                  {" · "}
                  <a href={run.url} target="_blank" rel="noreferrer" className="underline">
                    details
                  </a>
                </p>
              ) : null}
              {running ? <RefreshWhileRunning /> : null}
            </div>
          </section>

          {mayEdit && status ? (
            <section className="mt-6 grid gap-4 sm:grid-cols-3">
              <Link
                href="/channels/website/posts"
                className="rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:bg-sunk"
              >
                <Icon name="content" />
                <p className="mt-2 text-sm font-semibold text-ink">Blog</p>
                <p className="text-sm text-ink-soft">Write, edit and publish posts.</p>
              </Link>
              {[
                ["Pages", "Edit the main website’s pages."],
                ["Landing pages", "Build a page for a campaign."],
              ].map(([title, text]) => (
                <div key={title} className="rounded-xl border border-dashed border-line p-4">
                  <Icon name="website" />
                  <p className="mt-2 text-sm font-semibold text-ink-soft">{title}</p>
                  <p className="text-sm text-ink-faint">{text} Coming soon.</p>
                </div>
              ))}
            </section>
          ) : null}

          {mayConnect ? (
            <form action={disconnectWebsiteAction} className="mt-10">
              <CsrfField />
              <input type="hidden" name="connectionId" value={site.id} />
              <button type="submit" className="text-sm text-ink-faint underline hover:text-bad">
                Disconnect this website
              </button>
            </form>
          ) : null}
        </>
      )}
    </PortalShell>
  );
}
