import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/authorize";
import { jobStats, monthlyIntake, workOutcomes } from "@/lib/db";
import { PortalShell } from "../portal-shell";

export const metadata: Metadata = { title: "Analytics" };

const MONTHS = 6;

const monthLabel = (month: string, style: "short" | "long" = "short") =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-CA", { month: style, year: style === "long" ? "numeric" : undefined, timeZone: "UTC" });

/**
 * How the business is doing, in numbers, from its quotes and jobs. Read like
 * the jobs themselves: whoever may read this business's jobs may read this.
 */
export default async function AnalyticsPage() {
  const { ctx } = await requirePage("jobs.read", { returnPath: "/analytics" });

  const [stats, months, outcomes] = await Promise.all([
    jobStats(ctx.scope),
    monthlyIntake(ctx.scope, MONTHS),
    workOutcomes(ctx.scope),
  ]);

  const winRate = outcomes.quoted > 0 ? Math.round((outcomes.won / outcomes.quoted) * 100) : null;
  const top = Math.max(1, ...months.map((m) => Math.max(m.quotes, m.jobs)));
  const series = [
    { key: "quotes", label: "Quotes and estimates", color: "var(--series-1)" },
    { key: "jobs", label: "Jobs", color: "var(--series-2)" },
  ] as const;

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Analytics</h1>
      <p className="mt-1 text-sm text-ink-soft">How the business is doing, from its quotes and jobs.</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Received this month" value={String(stats.receivedThisMonth)} caption="Quotes and jobs sent in" />
        <Tile
          label="Open pipeline"
          value={String(stats.open + stats.inProgress)}
          caption={`${stats.open} new, ${stats.inProgress} in progress`}
        />
        <Tile
          label="Quotes won"
          value={winRate === null ? "—" : `${winRate}%`}
          caption={outcomes.quoted > 0 ? `${outcomes.won} of ${outcomes.quoted} became jobs` : "No quotes yet"}
        />
        <Tile
          label="Time to complete"
          value={
            outcomes.medianDaysToComplete === null
              ? "—"
              : outcomes.medianDaysToComplete < 1
                ? "Same day"
                : `${Math.round(outcomes.medianDaysToComplete)} ${Math.round(outcomes.medianDaysToComplete) === 1 ? "day" : "days"}`
          }
          caption={
            outcomes.completed > 0
              ? `Typical, across ${outcomes.completed} completed`
              : "Nothing completed yet"
          }
        />
      </div>

      <section className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">What came in, by month</h2>
          <ul className="flex flex-wrap gap-4 text-xs text-ink-soft" aria-label="Legend">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        </div>

        {/* The bars are a picture of the table below, which says the same in words. */}
        <div aria-hidden className="mt-6 grid h-48 grid-cols-6 items-end gap-2 border-b border-line">
          {months.map((m) => (
            <div key={m.month} className="group relative flex h-full items-end justify-center gap-[2px] rounded-t-md hover:bg-sunk/60">
              {series.map((s) => (
                <span
                  key={s.key}
                  className="w-full max-w-5 rounded-t-[4px]"
                  style={{ background: s.color, height: `${(m[s.key] / top) * 100}%`, minHeight: m[s.key] ? 2 : 0 }}
                />
              ))}
              <span
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap
                           rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink shadow-card group-hover:block"
              >
                <span className="block font-medium">{monthLabel(m.month, "long")}</span>
                {series.map((s) => (
                  <span key={s.key} className="mt-1 flex items-center gap-1.5 text-ink-soft">
                    <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                    {s.label}: <span className="tabular-nums text-ink">{m[s.key]}</span>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <div aria-hidden className="mt-2 grid grid-cols-6 gap-2 text-center text-xs text-ink-faint">
          {months.map((m) => (
            <span key={m.month}>{monthLabel(m.month)}</span>
          ))}
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-ink-soft hover:text-ink">Show as a table</summary>
          <table className="mt-3 w-full text-sm">
            <caption className="sr-only">Quotes and jobs that came in each month</caption>
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th scope="col" className="py-1 font-medium">Month</th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="py-1 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {months.map((m) => (
                <tr key={m.month}>
                  <th scope="row" className="py-1.5 text-left font-normal text-ink">{monthLabel(m.month, "long")}</th>
                  <td className="py-1.5 text-right tabular-nums text-ink">{m.quotes}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink">{m.jobs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h2 className="text-sm font-semibold text-ink">Everything, by status</h2>
        {stats.total === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">Nothing yet.</p>
        ) : (
          <dl className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {stats.byStatus.map((s) => (
              <div key={s.status} className="flex justify-between gap-4 border-b border-line-soft pb-2">
                <dt className="text-sm capitalize text-ink-soft">{s.status.replace(/_/g, " ")}</dt>
                <dd className="text-sm tabular-nums text-ink">{s.n}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </PortalShell>
  );
}

function Tile({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wider text-ink-faint">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="mt-1 text-xs text-ink-soft">{caption}</p>
    </div>
  );
}
