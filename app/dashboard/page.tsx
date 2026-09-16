import type { Metadata } from "next";
import Link from "next/link";
import { jobStats, recentJobs } from "@/lib/db";
import { requireSession } from "@/lib/auth/require";
import { liveGrantForSession, organizationById } from "@/lib/db/identity";
import { PortalShell } from "../portal-shell";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The operations overview.
 *
 * Laid out the way the Rotary storefront's admin dashboard is — an alert row
 * that names what needs attention, a row of figures, then the status breakdown
 * beside recent activity — because that arrangement is already familiar and it
 * puts the one actionable number at the top.
 *
 * The palette and type are 10XiD's own tokens throughout. Only the structure is
 * borrowed.
 */

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "New",
  in_progress: "In progress",
  awaiting_approval: "Awaiting approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  completed: "Completed",
  cancelled: "Cancelled",
};

const STATUS_DOT: Record<string, string> = {
  draft: "bg-ink-faint",
  open: "bg-brand",
  in_progress: "bg-warn",
  awaiting_approval: "bg-warn",
  changes_requested: "bg-bad",
  approved: "bg-good",
  completed: "bg-good",
  cancelled: "bg-ink-faint",
};

const STATUS_PILL: Record<string, string> = {
  draft: "bg-sunk text-ink-faint",
  open: "bg-brand-soft text-brand",
  in_progress: "bg-warn/15 text-warn",
  awaiting_approval: "bg-warn/15 text-warn",
  changes_requested: "bg-bad/10 text-bad",
  approved: "bg-good/10 text-good",
  completed: "bg-good/10 text-good",
  cancelled: "bg-sunk text-ink-faint",
};

function Tile({
  label,
  value,
  caption,
  accent,
}: {
  label: string;
  value: string;
  caption: string;
  accent: string;
}) {
  return (
    <div
      className={`rounded-xl border border-line bg-surface p-4 shadow-card border-l-4 ${accent}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="mt-1 text-xs leading-snug text-ink-faint">{caption}</p>
    </div>
  );
}

export default async function DashboardPage() {
  const ctx = await requireSession("/dashboard");

  const [stats, recent] = await Promise.all([
    jobStats(ctx.scope),
    recentJobs(ctx.scope, 6),
  ]);

  const grant = ctx.scope.isStaff
    ? await liveGrantForSession(ctx.sessionId)
    : null;
  const actingOrg = grant ? await organizationById(grant.organizationId) : null;

  const decided = stats.completed + (stats.byStatus.find((s) => s.status === "cancelled")?.n ?? 0);
  const completionRate =
    decided > 0 ? Math.round((stats.completed / decided) * 100) : null;

  const barTotal = stats.byStatus.reduce((s, r) => s + r.n, 0) || 1;

  // Every status, in workflow order, zeros included — the way the Rotary admin
  // does it. A breakdown that hides its empty rows makes "nothing is waiting on
  // approval" indistinguishable from "we do not track that".
  const counts = new Map(stats.byStatus.map((s) => [s.status, s.n]));
  const ORDER = [
    "draft",
    "open",
    "in_progress",
    "awaiting_approval",
    "changes_requested",
    "approved",
    "completed",
    "cancelled",
  ] as const;
  const fullBreakdown = ORDER.map((status) => ({
    status,
    n: counts.get(status) ?? 0,
  }));

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={
        actingOrg && grant ? { name: actingOrg.name, reason: grant.reason } : null
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Dashboard</h1>
      <p className="mt-1 text-sm text-ink-soft">
        {ctx.scope.isStaff && !ctx.scope.organizationId
          ? "Work in flight across every client."
          : "Work in flight, both directions."}
      </p>

      {stats.awaitingUs > 0 ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bad/30 bg-bad/5 px-4 py-3">
          <p className="text-sm text-ink">
            <span aria-hidden className="mr-2 text-bad">
              ⚠
            </span>
            <strong>
              {stats.awaitingUs} {stats.awaitingUs === 1 ? "job" : "jobs"} awaiting
              a response
            </strong>
            {stats.oldestAwaitingDays !== null ? (
              <span className="text-ink-soft">
                {" "}
                — oldest is {stats.oldestAwaitingDays}{" "}
                {stats.oldestAwaitingDays === 1 ? "day" : "days"} old
              </span>
            ) : null}
          </p>
          <Link
            href="/jobs"
            className="flex-none text-xs font-semibold uppercase tracking-wider
                       text-bad transition-colors hover:text-ink"
          >
            Review →
          </Link>
        </div>
      ) : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Tile
          label="Open pipeline"
          value={String(stats.open + stats.inProgress)}
          caption="New and in progress"
          accent="border-l-brand"
        />
        <Tile
          label="Sent this month"
          value={String(stats.sentThisMonth)}
          caption="Jobs we sent out"
          accent="border-l-warn"
        />
        <Tile
          label="Received this month"
          value={String(stats.receivedThisMonth)}
          caption="Jobs sent to us"
          accent="border-l-accent"
        />
        <Tile
          label="Completion rate"
          value={completionRate === null ? "—" : `${completionRate}%`}
          caption={
            decided > 0
              ? `${stats.completed} completed of ${decided} decided`
              : "Nothing decided yet"
          }
          accent="border-l-good"
        />
        <Tile
          label="Total jobs"
          value={String(stats.total)}
          caption="All time, excluding archived"
          accent="border-l-line"
        />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="rounded-xl border border-line bg-surface p-5 shadow-card">
          <h2 className="text-sm font-semibold text-ink">Jobs by status</h2>

          <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-sunk">
            {stats.byStatus.map((s) => (
              <span
                key={s.status}
                className={STATUS_DOT[s.status] ?? "bg-ink-faint"}
                style={{ width: `${(s.n / barTotal) * 100}%` }}
                title={`${STATUS_LABEL[s.status] ?? s.status}: ${s.n}`}
              />
            ))}
          </div>

          <ul className="mt-4 space-y-2">
            {fullBreakdown.map((s) => (
              <li
                key={s.status}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span
                  className={`flex items-center gap-2 ${
                    s.n === 0 ? "text-ink-faint" : "text-ink-soft"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 flex-none rounded-full ${
                      s.n === 0 ? "bg-line" : STATUS_DOT[s.status] ?? "bg-ink-faint"
                    }`}
                  />
                  {STATUS_LABEL[s.status] ?? s.status}
                </span>
                <span
                  className={`tabular-nums ${
                    s.n === 0 ? "text-ink-faint" : "text-ink"
                  }`}
                >
                  {s.n}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-line bg-surface shadow-card">
          <div className="flex items-center justify-between gap-3 px-5 pt-5">
            <h2 className="text-sm font-semibold text-ink">Recent jobs</h2>
            <Link
              href="/jobs"
              className="text-xs font-medium text-brand transition-colors hover:text-brand-dark"
            >
              View all →
            </Link>
          </div>

          <ul className="mt-3 divide-y divide-line-soft">
            {recent.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-ink-faint">
                Nothing yet.
              </li>
            ) : (
              recent.map((job) => (
                <li key={job.id}>
                  <Link
                    href={`/jobs/${job.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3
                               transition-colors duration-150 hover:bg-sunk
                               focus-visible:outline-2 focus-visible:-outline-offset-2
                               focus-visible:outline-brand"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">{job.title}</p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {job.organizationName} ·{" "}
                        {new Date(job.createdAt).toLocaleDateString("en-CA", {
                          month: "short",
                          day: "numeric",
                        })}
                        {job.direction === "from_client" ? " · sent in" : " · sent out"}
                      </p>
                    </div>
                    <span className="flex-none font-mono text-xs tabular-nums text-ink-faint">
                      {job.ref}
                    </span>
                    <span
                      className={`flex-none rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_PILL[job.status] ?? "bg-sunk text-ink-faint"
                      }`}
                    >
                      {STATUS_LABEL[job.status] ?? job.status}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </PortalShell>
  );
}
