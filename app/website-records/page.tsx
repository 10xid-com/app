import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { websiteFor } from "@/lib/db/sites";
import { websiteCopyFor, type WebsiteCopy } from "@/lib/db/site-copy";
import { PortalShell } from "../portal-shell";

export const metadata: Metadata = { title: "Website records" };

/**
 * The business's website records, as last copied (login's 0038,
 * lib/sites/site-copy.ts): its jobs, clients, stock, posts and their social
 * posts. Read-only: the website is the master copy, and these are changed in
 * its own admin, which this page links to.
 */
export default async function WebsiteRecordsPage() {
  const { ctx, businessId } = await requirePage("jobs.read", { returnPath: "/website-records" });
  const site = await websiteFor({ organizationId: businessId, userId: ctx.userId });
  const data = site ? await websiteCopyFor(ctx.scope, site.id) : null;

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null} wide>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Website records</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          A copy of the jobs, clients, stock, posts and social posts kept on your website, refreshed every few minutes.
          The website is the master copy: change them in{" "}
          {site ? (
            <a href={`${site.siteUrl}/admin/`} className="text-brand underline underline-offset-2" target="_blank" rel="noopener noreferrer">
              its admin
            </a>
          ) : (
            "its admin"
          )}
          .
        </p>
      </div>
      {!site ? (
        <Empty>
          No website is connected. Connect one under <Link href="/channels/website" className="text-brand underline underline-offset-2">Channels → Website</Link>.
        </Empty>
      ) : !data ? (
        <Empty>{site.siteUrl.replace("https://", "")} has not been copied yet. The first copy arrives within a few minutes.</Empty>
      ) : (
        <Records data={data} />
      )}
    </PortalShell>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-line bg-surface p-5 text-sm text-ink-soft shadow-card">{children}</p>;
}

const when = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");
const day = (s: string | null) => (s ? s.slice(0, 10) : "—");

const CHANNEL: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X",
};

function Card({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-line bg-surface shadow-card">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <span className="text-xs tabular-nums text-ink-faint">{count}</span>
      </div>
      {count === 0 ? <p className="px-5 py-4 text-sm text-ink-faint">None yet.</p> : <div className="overflow-x-auto">{children}</div>}
    </section>
  );
}

const TH = "px-4 py-2 text-left text-xs font-medium text-ink-faint whitespace-nowrap";
const TD = "px-4 py-2 text-sm text-ink align-top";

function Records({ data }: { data: WebsiteCopy }) {
  const { copy, jobs, clients, materials, posts, socialProfiles } = data;
  const clientName = new Map(clients.map((c) => [c.sourceId, c.business || c.name]));
  const postTitle = new Map(posts.map((p) => [p.sourceId, p]));
  return (
    <>
      <p className="mb-4 text-xs text-ink-faint">
        Copied from {copy.siteUrl.replace("https://", "")} · last copy {when(copy.copiedAt)}
        {copy.generatedAt ? ` · made by the site ${when(copy.generatedAt)}` : ""}
      </p>
      {copy.error ? (
        <p role="status" className="mb-4 rounded-lg bg-warn/15 px-4 py-2 text-sm text-warn">
          The last attempt ({when(copy.triedAt)}) did not copy: {copy.error} This shows the last good copy.
        </p>
      ) : null}

      <Card title="Jobs" count={jobs.length}>
        <table className="w-full">
          <thead>
            <tr>
              <th className={TH}>#</th>
              <th className={TH}>Customer</th>
              <th className={TH}>Vehicle</th>
              <th className={TH}>Service</th>
              <th className={TH}>Status</th>
              <th className={TH}>Completed</th>
              <th className={TH}>Posted</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const post = j.postSourceId ? postTitle.get(j.postSourceId) : undefined;
              return (
                <tr key={j.sourceId} className="border-t border-line">
                  <td className={`${TD} font-mono text-xs text-ink-faint`}>{j.sourceId}</td>
                  <td className={TD}>
                    {j.clientSourceId ? clientName.get(j.clientSourceId) ?? j.customerName : j.customerName}
                  </td>
                  <td className={TD}>{j.vehicle ?? "—"}</td>
                  <td className={TD}>{j.service ?? "—"}</td>
                  <td className={TD}>{j.status.replace(/_/g, " ")}</td>
                  <td className={`${TD} tabular-nums`}>{day(j.completedAt)}</td>
                  <td className={TD}>
                    {post ? (
                      <a href={post.url} className="text-brand underline underline-offset-2" target="_blank" rel="noopener noreferrer">
                        {post.title}
                      </a>
                    ) : j.postedAt ? (
                      "Posted"
                    ) : j.postSkipped ? (
                      <span className="text-ink-faint">No post needed</span>
                    ) : j.status === "completed" ? (
                      <span className="text-warn">To post</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Clients" count={clients.length}>
        <table className="w-full">
          <thead>
            <tr>
              <th className={TH}>Name</th>
              <th className={TH}>Business</th>
              <th className={TH}>Email</th>
              <th className={TH}>Phone</th>
              <th className={TH}>Handle</th>
              <th className={TH}>Named in posts</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.sourceId} className="border-t border-line">
                <td className={TD}>{c.name}</td>
                <td className={TD}>{c.business ?? "—"}</td>
                <td className={TD}>{c.email ?? "—"}</td>
                <td className={TD}>{c.phone ?? "—"}</td>
                <td className={TD}>{c.handle ?? "—"}</td>
                <td className={TD}>{c.mayFeature ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Stock" count={materials.length}>
        <table className="w-full">
          <thead>
            <tr>
              <th className={TH}>Material</th>
              <th className={TH}>Kind</th>
              <th className={TH}>Finish</th>
              <th className={`${TH} text-right`}>On hand</th>
              <th className={TH}></th>
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const low = m.reorderAt !== null && m.onHand <= m.reorderAt;
              return (
                <tr key={m.sourceId} className={`border-t border-line ${m.active ? "" : "opacity-60"}`}>
                  <td className={TD}>{[m.brand, m.product, m.colour, m.code].filter(Boolean).join(" · ")}</td>
                  <td className={TD}>{m.kind === "vinyl" && m.type ? `vinyl (${m.type})` : m.kind}</td>
                  <td className={TD}>{m.finish ?? "—"}</td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {m.onHand} {m.unit}
                  </td>
                  <td className={TD}>
                    {low ? <span className="rounded-full bg-bad/10 px-2 py-0.5 text-xs font-medium text-bad">Running low</span> : null}
                    {!m.active ? <span className="text-xs text-ink-faint">Not in use</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Posts and their social posts" count={posts.length}>
        <ul>
          {posts.map((p) => (
            <li key={p.sourceId} className="border-t border-line px-5 py-3 first:border-t-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <a href={p.url} className="min-w-0 text-sm font-medium text-brand underline underline-offset-2" target="_blank" rel="noopener noreferrer">
                  {p.title || p.slug}
                </a>
                <span className="text-xs text-ink-faint">
                  {p.status}
                  {p.publishedAt ? ` · ${day(p.publishedAt)}` : ""}
                  {p.stageOnly ? " · stage site only" : ""}
                </span>
              </div>
              {p.socials.length ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {p.socials.map((s) => (
                    <li key={s.position}>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                          s.linked ? "border-good/40 bg-good/10 text-good" : "border-line text-ink-faint"
                        }`}
                      >
                        {CHANNEL[s.channel] ?? s.channel} · {s.linked ? "post" : "profile"}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-ink-faint">No social row.</p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Social profiles" count={socialProfiles.length}>
        <ul className="flex flex-wrap gap-2 px-5 py-4">
          {socialProfiles.map((s) => (
            <li key={s.position}>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-sm text-brand underline underline-offset-2">
                {CHANNEL[s.channel] ?? s.channel}
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
