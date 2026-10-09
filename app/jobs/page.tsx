import type { Metadata } from "next";
import Link from "next/link";
import { listJobs } from "@/lib/db";
import { teamFor } from "@/lib/db/identity";
import { requirePage } from "@/lib/auth/authorize";
import { JOB_KIND_LABELS, JOB_KINDS, roleAllows, type JobKind } from "@/lib/auth/permissions";
import { PortalShell } from "../portal-shell";
import { CsrfField } from "../_components/csrf-field";
import { JobKindBadge } from "../_components/job-kind";
import { createJobAction } from "./actions";

export const metadata: Metadata = { title: "Jobs" };

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-sunk text-ink-faint",
  open: "bg-brand-soft text-brand",
  in_progress: "bg-warn/15 text-warn",
  awaiting_approval: "bg-warn/15 text-warn",
  changes_requested: "bg-bad/10 text-bad",
  approved: "bg-good/10 text-good",
  completed: "bg-good/10 text-good",
  cancelled: "bg-sunk text-ink-faint",
};

const isKind = (v: string | undefined): v is JobKind => (JOB_KINDS as readonly string[]).includes(v ?? "");

const ERRORS: Record<string, string> = {
  title: "A job needs a title of at least three characters.",
  noclient:
    "Choose a client before creating a job — staff act on one client at a time.",
};

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; view?: string; type?: string }>;
}) {
  const { ctx, role, businessId } = await requirePage("jobs.read", { returnPath: "/jobs" });
  const params = await searchParams;
  // "Assigned to me" is the work handed to this person: their list of what to do.
  const mine = params.view === "mine";
  // Quotes, estimates or jobs only. Anything else in the address is all of them.
  const kind = isKind(params.type) ? params.type : undefined;
  const href = (next: { mine?: boolean; kind?: JobKind }) => {
    const q = new URLSearchParams();
    if (next.mine) q.set("view", "mine");
    if (next.kind) q.set("type", next.kind);
    return q.size ? `/jobs?${q}` : "/jobs";
  };

  const [jobs, team] = await Promise.all([
    listJobs(ctx.scope, { assignedTo: mine ? ctx.userId : undefined, kind }),
    teamFor(businessId),
  ]);
  const holder = (userId: string | null) => {
    if (!userId) return null;
    if (userId === ctx.userId) return "You";
    const person = team.find((p) => p.userId === userId);
    return person ? person.fullName || person.email : "Somebody no longer here";
  };

  const canWrite = roleAllows(role, "jobs.create");

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={null}
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Jobs</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {ctx.scope.isStaff && !canWrite
              ? `Every client's jobs. Choose a client to act on one.`
              : `Work in flight, both directions.`}
          </p>
        </div>
        <span className="text-sm tabular-nums text-ink-faint">
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav aria-label="Whose jobs" className="flex flex-1 gap-1 rounded-lg bg-sunk p-1 text-sm sm:flex-none">
        {[
          { href: href({ kind }), label: "All jobs", current: !mine },
          { href: href({ mine: true, kind }), label: "Assigned to me", current: mine },
        ].map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.current ? "page" : undefined}
            className={`flex-1 rounded-md px-3 py-1.5 text-center font-medium transition-colors duration-150
                        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:flex-none ${
                          tab.current ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink"
                        }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <nav aria-label="Which kind" className="flex flex-wrap gap-1.5 text-xs">
        {[undefined, ...JOB_KINDS].map((k) => {
          const current = k === kind;
          return (
            <Link
              key={k ?? "all"}
              href={href({ mine, kind: k })}
              aria-current={current ? "page" : undefined}
              className={`rounded-full border px-2.5 py-1 font-medium transition-colors duration-150
                          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                            current ? "border-ink bg-ink text-surface" : "border-line text-ink-soft hover:text-ink"
                          }`}
            >
              {k ? `${JOB_KIND_LABELS[k]}s` : "All types"}
            </Link>
          );
        })}
      </nav>
      </div>

      {params.error ? (
        <p
          role="alert"
          className="mb-5 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
        >
          {ERRORS[params.error] ?? "That did not work."}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {jobs.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-faint">
            {mine
              ? `Nothing handed to you right now${kind ? ` that is ${kind === "estimate" ? "an" : "a"} ${kind}` : ""}.`
              : kind
                ? `No ${kind}s yet.`
                : "Nothing here yet."}
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/jobs/${job.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3
                             transition-colors duration-150 hover:bg-sunk
                             focus-visible:outline-2 focus-visible:-outline-offset-2
                             focus-visible:outline-brand"
                >
                  <span className="w-20 flex-none font-mono text-xs tabular-nums text-ink-faint">
                    {job.ref}
                  </span>
                  <JobKindBadge kind={job.kind} className="w-[4.75rem] flex-none" />
                  {/* On a phone the title gets its own line, first, rather than a few letters. */}
                  <span className="order-first w-full min-w-0 truncate text-sm text-ink sm:order-none sm:w-auto sm:flex-1">
                    {job.title}
                  </span>
                  <span className="flex-none text-xs text-ink-faint">
                    {job.direction === "from_client" ? "→ us" : "→ client"}
                  </span>
                  {!mine ? (
                    <span className="w-28 flex-none truncate text-xs text-ink-soft">
                      {holder(job.assignedTo) ?? <span className="text-ink-faint">Unassigned</span>}
                    </span>
                  ) : null}
                  <span
                    className={`flex-none rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLE[job.status] ?? "bg-sunk text-ink-faint"
                    }`}
                  >
                    {job.status.replace(/_/g, " ")}
                  </span>
                  <span className="w-24 flex-none text-right text-xs tabular-nums text-ink-faint">
                    {job.dueAt
                      ? new Date(job.dueAt).toISOString().slice(0, 10)
                      : "—"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="mt-8 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h2 className="text-sm font-semibold text-ink">Send a new job</h2>
        {canWrite ? (
          <form action={createJobAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto_auto]">
            <CsrfField />
            <input
              name="title"
              required
              minLength={3}
              placeholder="What needs doing?"
              aria-label="Job title"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm
                         text-ink placeholder:text-ink-faint focus:border-brand
                         focus:outline-2 focus:outline-brand/30"
            />
            <select
              name="kind"
              aria-label="Type"
              defaultValue="job"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink
                         focus:border-brand focus:outline-2 focus:outline-brand/30"
            >
              {JOB_KINDS.map((k) => (
                <option key={k} value={k}>
                  {JOB_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <select
              name="direction"
              aria-label="Direction"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink
                         focus:border-brand focus:outline-2 focus:outline-brand/30"
            >
              <option value="from_client">We are sending it in</option>
              <option value="to_client">We are sending it out</option>
            </select>
            <input
              type="date"
              name="dueAt"
              aria-label="Due date"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink
                         focus:border-brand focus:outline-2 focus:outline-brand/30"
            />
            <button
              type="submit"
              className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface
                         transition-colors duration-150 hover:bg-brand-surface-hover
                         focus-visible:outline-2 focus-visible:outline-offset-2
                         focus-visible:outline-brand"
            >
              Send
            </button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            You are viewing every client. <Link href="/staff" className="text-brand underline underline-offset-2">Choose a client</Link> to send a job on their behalf.
          </p>
        )}
      </section>
    </PortalShell>
  );
}
