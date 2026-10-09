import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { organizationById } from "@/lib/db/identity";
import { listLinkedRepositories } from "@/lib/db/repositories";
import { websiteFor } from "@/lib/db/sites";
import { SiteError, siteRequest, siteSigningConfigured } from "@/lib/sites/client";
import { siteActorFor } from "@/lib/sites/website";
import type { SiteActor } from "@/lib/sites/sign";
import { PortalShell } from "../../portal-shell";
import { CsrfField } from "../../_components/csrf-field";
import { Icon } from "../../_components/icons";
import { connectWebsiteAction, disconnectWebsiteAction, publishWebsiteAction, revokeFormKeyAction, setWebsiteRepositoryAction } from "./actions";
import { MintFormKey } from "./form-key";
import { listKeys } from "@/lib/db/api-keys";
import { resolveIdentity } from "@/lib/auth/session";
import { appOrigin } from "@/lib/auth/origin";
import { githubApp } from "@/lib/repo";
import { RepoError } from "@/lib/repo/types";
import { RefreshWhileRunning } from "./refresh";
import { SitePreview } from "../../_components/site-preview";
import { SubmitButton } from "../../_components/submit-button";

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
  elsewhere: "That repository is linked to another business. Unlink it there first.",
  github: "GitHub could not be reached. Try again in a moment.",
};
const DONE: Record<string, string> = {
  connected: "Website connected.",
  disconnected: "Website disconnected. Nothing on the site was changed.",
  published: "Publishing started. The site rebuilds and goes live in a few minutes.",
  repo: "Repository saved. Chat Boss can now read the website’s code.",
  norepo: "Repository removed from the website.",
  keyrevoked: "Key revoked. The website can no longer send enquiries with it.",
};

type Status = {
  posts: { all: number; published: number; draft: number; scheduled: number; archived: number };
  publishing: boolean;
};
type Run = { status: string; conclusion: string | null; startedAt: string; url: string } | null;

export default async function WebsitePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string; done?: string; repo?: string }>;
}) {
  const granted = await requirePage("business.view", { returnPath: "/channels/website" });
  const { ctx, businessId, role, via } = granted;
  const owner = { organizationId: businessId, userId: ctx.userId };
  const params = await searchParams;

  const [site, business] = await Promise.all([websiteFor(owner), organizationById(businessId)]);
  const mayConnect = allows(role, "domains.manage", via);
  const mayEdit = allows(role, "pages.edit", via);
  const mayPublish = allows(role, "pages.publish", via);
  // Linked repositories: offered when connecting, and named on the card once
  // connected. What else the GitHub App can see is asked of GitHub only when
  // an owner opens the repository form, so the page never waits on it.
  const repositories = mayConnect || site ? await listLinkedRepositories(owner) : [];
  const siteRepo = site?.repositoryId ? repositories.find((r) => r.id === site.repositoryId) : undefined;
  const editingRepo = Boolean(site && mayConnect && params.repo === "edit");
  let onGitHub: { externalId: number; name: string; private: boolean }[] = [];
  let gitHubProblem: string | null = null;
  const app = editingRepo ? githubApp() : null;
  if (editingRepo && !app) gitHubProblem = "The GitHub App is not set up on this server.";
  if (app) {
    try {
      const linked = new Set(repositories.map((r) => r.externalId));
      onGitHub = (await app.listAccessibleRepositories())
        .filter((r) => !linked.has(r.externalId))
        .map((r) => ({ externalId: r.externalId, name: `${r.owner}/${r.name}`, private: r.private }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      if (!(err instanceof RepoError)) throw err;
      gitHubProblem = "GitHub could not be reached, so only repositories already linked are listed.";
    }
  }
  const signing = siteSigningConfigured();
  // The keys the website's forms file enquiries with: owners only.
  const [keys, identity] = site && mayConnect ? await Promise.all([listKeys(ctx.scope), resolveIdentity()]) : [[], null];
  const liveKeys = keys.filter((k) => !k.revokedAt);

  // What the site says about itself. Only for people who may edit: the site
  // answers nobody else. It is asked now and NOT awaited: the parts of the page
  // that need it (the Publish button, the numbers, the tiles) wait for it in
  // their own Suspense boundaries, and everything else is shown at once.
  const live: Promise<SiteState> =
    site && mayEdit && signing
      ? loadSiteState(site.siteUrl, siteActorFor(granted, business?.name ?? ""))
      : Promise.resolve({ status: null, run: null, problem: null });

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
              {mayPublish ? (
                <Suspense fallback={null}>
                  <PublishButton live={live} />
                </Suspense>
              ) : null}
            </div>

            <div className="border-b border-line-soft px-5 py-3 text-sm">
              {editingRepo ? (
                <form action={setWebsiteRepositoryAction} className="grid gap-3 sm:max-w-md">
                  <CsrfField />
                  <label className="grid gap-1.5">
                    <span className="font-medium text-ink">Repository the website is built from</span>
                    <select
                      name="repository"
                      defaultValue={siteRepo ? `linked:${siteRepo.id}` : (onGitHub.length || repositories.length ? "" : "none")}
                      required
                      className="rounded-lg border border-line bg-surface px-3 py-2 text-ink"
                    >
                      <option value="" disabled>
                        Choose a repository
                      </option>
                      {repositories.length ? (
                        <optgroup label={`Linked to ${business?.name ?? "this business"}`}>
                          {repositories.map((r) => (
                            <option key={r.id} value={`linked:${r.id}`}>
                              {r.owner}/{r.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {onGitHub.length ? (
                        <optgroup label="On GitHub, not linked yet">
                          {onGitHub.map((r) => (
                            <option key={r.externalId} value={`github:${r.externalId}`}>
                              {r.name}
                              {r.private ? " (private)" : ""}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      <option value="none">None</option>
                    </select>
                  </label>
                  {gitHubProblem ? <p className="text-xs text-warn">{gitHubProblem}</p> : null}
                  <p className="text-xs text-ink-faint">
                    Read-only. A repository picked from GitHub is linked to {business?.name ?? "this business"}, and only
                    its people can read it in Chat Boss.
                  </p>
                  <div className="flex items-center gap-3">
                    <SubmitButton
                      pendingLabel="Saving…"
                      className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-60"
                    >
                      Save repository
                    </SubmitButton>
                    <Link href="/channels/website" className="text-sm text-ink-soft underline hover:text-ink">
                      Cancel
                    </Link>
                  </div>
                </form>
              ) : (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-soft">
                  <Icon name="github" className="h-4 w-4" />
                  <span>Repository:</span>
                  <span className={siteRepo ? "font-medium text-ink" : "text-ink-faint"}>
                    {siteRepo ? `${siteRepo.owner}/${siteRepo.name}` : site.repositoryId ? "no longer linked" : "none"}
                  </span>
                  {mayConnect ? (
                    <Link href="/channels/website?repo=edit" className="font-medium text-brand hover:underline">
                      {siteRepo ? "Change" : "Add one"}
                    </Link>
                  ) : null}
                </p>
              )}
            </div>

            <SitePreview url={site.siteUrl} />

            <div className="border-t border-line-soft px-5 py-4 text-sm">
              {!mayEdit ? (
                <p className="text-ink-soft">Your role can see that the website is connected. Editors and publishers work on it here.</p>
              ) : !signing ? (
                <p className="text-warn">The portal is not set up to talk to websites yet (its signing key is missing).</p>
              ) : (
                <Suspense fallback={<StatsLoading />}>
                  <SiteStats live={live} />
                </Suspense>
              )}
            </div>
          </section>

          {mayEdit ? (
            <Suspense fallback={null}>
              <Tiles live={live} />
            </Suspense>
          ) : null}

          {mayConnect ? (
            <section id="forms" className="mt-6 scroll-mt-6 rounded-2xl border border-line bg-surface p-5 shadow-card">
              <h2 className="text-base font-semibold text-ink">Website forms</h2>
              <p className="mt-1 max-w-prose text-sm text-ink-soft">
                Enquiries from the website&rsquo;s forms land in Jobs as quotes and estimates, with everything the
                customer typed. The website sends them with a key made here; only owners see this.
              </p>

              {liveKeys.length ? (
                <ul className="mt-4 divide-y divide-line-soft rounded-xl border border-line">
                  {liveKeys.map((k) => (
                    <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">{k.label}</span>
                      <code className="font-mono text-xs text-ink-faint">{k.prefix}…</code>
                      <span className="text-xs text-ink-faint">
                        {k.lastUsedAt ? `Last used ${k.lastUsedAt.toISOString().slice(0, 10)}` : "Not used yet"}
                        {" · "}
                        {k.jobsFiled} {k.jobsFiled === 1 ? "enquiry" : "enquiries"}
                      </span>
                      <form action={revokeFormKeyAction}>
                        <CsrfField />
                        <input type="hidden" name="keyId" value={k.id} />
                        <button type="submit" className="text-xs font-medium text-ink-faint underline hover:text-bad">
                          Revoke
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-ink-faint">No key yet, so the website&rsquo;s forms are not sending anything here.</p>
              )}

              <div className="mt-4">
                {identity?.state === "active" ? <MintFormKey csrfToken={identity.csrfToken} /> : null}
              </div>
              <p className="mt-3 text-xs text-ink-faint">
                The website posts each enquiry from its server to{" "}
                <code className="font-mono">{appOrigin() ?? ""}/api/v1/jobs</code>. A key can only add work here; it
                cannot read anything.
              </p>
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

type SiteState = { status: Status | null; run: Run; problem: string | null };

/** The site's own account of itself: its posts, and how the last publish went. */
async function loadSiteState(siteUrl: string, actor: SiteActor): Promise<SiteState> {
  try {
    const [s, d] = await Promise.all([
      siteRequest({ siteUrl, actor, method: "GET", path: "/api/10xid/status/" }),
      siteRequest({ siteUrl, actor, method: "GET", path: "/api/10xid/deploy/" }),
    ]);
    return {
      status: s.status === 200 ? (s.body as unknown as Status) : null,
      problem: s.status === 200 ? null : typeof s.body.error === "string" ? s.body.error : `The site answered ${s.status}.`,
      run: d.status === 200 ? ((d.body.run as Run) ?? null) : null,
    };
  } catch (err) {
    if (!(err instanceof SiteError)) throw err;
    return { status: null, run: null, problem: err.message };
  }
}

const isRunning = (run: Run) => run !== null && run.status !== "completed";

async function PublishButton({ live }: { live: Promise<SiteState> }) {
  const { status, run } = await live;
  if (!status) return null;
  const running = isRunning(run);
  return (
    <form action={publishWebsiteAction}>
      <CsrfField />
      <SubmitButton
        pendingLabel="Starting…"
        disabled={running || !status.publishing}
        className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-50"
      >
        {running ? "Publishing…" : "Publish"}
      </SubmitButton>
    </form>
  );
}

function StatsLoading() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true" aria-label="Asking the site">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[58px] animate-pulse rounded-lg bg-sunk" />
      ))}
    </div>
  );
}

async function SiteStats({ live }: { live: Promise<SiteState> }) {
  const { status, run, problem } = await live;
  const running = isRunning(run);
  return (
    <>
      {problem ? (
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
          <span className={`h-2 w-2 rounded-full ${running ? "bg-warn" : run.conclusion === "success" ? "bg-good" : "bg-bad"}`} />
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
    </>
  );
}

async function Tiles({ live }: { live: Promise<SiteState> }) {
  const { status } = await live;
  if (!status) return null;
  return (
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
  );
}
