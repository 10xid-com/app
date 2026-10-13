import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { submissions } from "@/lib/db";
import { customersFrom, matches } from "@/lib/customers";
import { PortalShell } from "../portal-shell";
import { JobKindBadge } from "../_components/job-kind";
import { workPath } from "../jobs/section";

export const metadata: Metadata = { title: "Customers" };

const day = (d: Date) => d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });

/**
 * The people who send work in, from what they typed into the website's forms
 * (lib/customers.ts). Read like the jobs they came from, so whoever may read
 * this business's jobs may read this.
 */
export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { ctx } = await requirePage("jobs.read", { returnPath: "/customers" });
  const q = ((await searchParams).q ?? "").slice(0, 100);

  const { customers, anonymous } = customersFrom(await submissions(ctx.scope));
  const shown = customers.filter((c) => matches(c, q));

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Customers</h1>
          <p className="mt-1 text-sm text-ink-soft">Everyone who has sent you a request, and what they asked for.</p>
        </div>
        <span className="text-sm tabular-nums text-ink-faint">
          {customers.length} {customers.length === 1 ? "customer" : "customers"}
        </span>
      </div>

      <form action="/customers" className="mt-5 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by name, email, phone or request"
          aria-label="Search customers"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint
                     focus:border-brand focus:outline-2 focus:outline-brand/30"
        />
        <button type="submit" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-sunk">
          Search
        </button>
      </form>

      <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {shown.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-faint">
            {q
              ? `Nobody matches “${q}”.`
              : "No customers yet. When someone fills in a form on your website, they appear here."}
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {shown.map((c) => (
              <li key={c.key}>
                <details className="group">
                  <summary
                    className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3
                               transition-colors hover:bg-sunk focus-visible:outline-2 focus-visible:-outline-offset-2
                               focus-visible:outline-brand [&::-webkit-details-marker]:hidden"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {c.name ?? c.email ?? c.phone}
                      </span>
                      <span className="block truncate text-xs text-ink-soft">
                        {[c.name ? c.email : null, c.phone].filter(Boolean).join(" · ") || " "}
                      </span>
                    </span>
                    <span className="flex-none text-xs tabular-nums text-ink-soft">
                      {c.submissions.length} {c.submissions.length === 1 ? "request" : "requests"}
                    </span>
                    <span className="w-28 flex-none text-right text-xs tabular-nums text-ink-faint">Last {day(c.last)}</span>
                    <span aria-hidden className="flex-none text-ink-faint transition-transform group-open:rotate-90">
                      ›
                    </span>
                  </summary>
                  <div className="border-t border-line-soft bg-sunk/50 px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {c.email ? (
                        <a href={`mailto:${c.email}`} className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-sunk">
                          Email
                        </a>
                      ) : null}
                      {c.phone ? (
                        <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-sunk">
                          Call
                        </a>
                      ) : null}
                      <span className="self-center text-xs text-ink-faint">Customer since {day(c.first)}</span>
                    </div>
                    <ul className="mt-3 grid gap-1.5">
                      {c.submissions.map((s) => (
                        <li key={s.id}>
                          <Link
                            href={workPath(s.kind, s.id)}
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface px-3 py-2 text-sm hover:bg-sunk"
                          >
                            <span className="w-20 flex-none font-mono text-xs tabular-nums text-ink-faint">{s.ref}</span>
                            <JobKindBadge kind={s.kind} className="w-[4.75rem] flex-none" />
                            <span className="min-w-0 flex-1 truncate text-ink">{s.title}</span>
                            <span className="flex-none text-xs text-ink-soft">{s.status.replace(/_/g, " ")}</span>
                            <span className="w-24 flex-none text-right text-xs tabular-nums text-ink-faint">{day(s.createdAt)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>

      {anonymous > 0 ? (
        <p className="mt-3 text-xs text-ink-faint">
          {anonymous} {anonymous === 1 ? "request" : "requests"} came in without a name, email or phone number, so
          {anonymous === 1 ? " it is" : " they are"} not listed here. {anonymous === 1 ? "It is" : "They are"} still under{" "}
          <Link href="/quotes" className="underline underline-offset-2">Quotes</Link> and{" "}
          <Link href="/jobs" className="underline underline-offset-2">Jobs</Link>.
        </p>
      ) : null}
    </PortalShell>
  );
}
