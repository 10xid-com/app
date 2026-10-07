import type { Metadata } from "next";
import Link from "next/link";
import { listJobs } from "@/lib/db";
import { requireSession } from "@/lib/auth/require";
import { liveGrantForSession, organizationById } from "@/lib/db/identity";
import { PortalShell } from "../portal-shell";
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

const ERRORS: Record<string, string> = {
  title: "A job needs a title of at least three characters.",
  noclient:
    "Choose a client before creating a job — staff act on one client at a time.",
};

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await requireSession("/jobs");
  const params = await searchParams;

  const jobs = await listJobs(ctx.scope);

  const grant = ctx.scope.isStaff
    ? await liveGrantForSession(ctx.sessionId)
    : null;
  const actingOrg = grant ? await organizationById(grant.organizationId) : null;

  const canWrite = ctx.scope.organizationId !== null;

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={
        actingOrg && grant
          ? { name: actingOrg.name, reason: grant.reason }
          : null
      }
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
            Nothing here yet.
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
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {job.title}
                  </span>
                  <span className="flex-none text-xs text-ink-faint">
                    {job.direction === "from_client" ? "→ us" : "→ client"}
                  </span>
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
          <form action={createJobAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
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
