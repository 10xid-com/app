import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getJob, listJobEvents } from "@/lib/db";
import { requireSession } from "@/lib/auth/require";
import { liveGrantForSession, organizationById } from "@/lib/db/identity";
import { PortalShell } from "../../portal-shell";
import { setJobStatusAction } from "../actions";

export const metadata: Metadata = { title: "Job" };

const STATUSES = [
  "open",
  "in_progress",
  "awaiting_approval",
  "changes_requested",
  "approved",
  "completed",
  "cancelled",
] as const;

/**
 * One job, addressed by the id in the URL.
 *
 * This is the page the isolation test attacks: signed in as one client, ask for
 * another client's job by its exact id. There is deliberately no "fetch it,
 * then check whether you're allowed" here — the row is simply not visible
 * outside its own company, so the answer is `notFound()`, byte for byte the
 * same as for an id that never existed.
 *
 * That matters beyond the obvious. An endpoint that says "forbidden" for real
 * jobs and "not found" for imaginary ones is an endpoint that confirms which
 * ids are real, and it will happily enumerate a competitor's workload for
 * anyone patient enough to ask.
 */
/**
 * Pull the submitted payload out of the creation event.
 *
 * The event's `after` column is jsonb, so what comes back is whatever was
 * written — this narrows it rather than trusting it. Values are rendered as
 * text and never as markup, because they are, by definition, strings typed by
 * an anonymous member of the public into a form.
 */
function submittedDetails(
  events: Array<{ action: string; after: unknown }>,
): Record<string, string> | null {
  const created = events.find((e) => e.action === "created");
  if (!created || typeof created.after !== "object" || created.after === null) {
    return null;
  }

  const details = (created.after as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) return null;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireSession(`/jobs/${id}`);

  const job = await getJob(ctx.scope, id);
  if (!job) notFound();

  const events = await listJobEvents(ctx.scope, id);

  // What the sender filled in, if this job arrived from a form rather than from
  // these screens. It is read off the creation event rather than from columns on
  // the job, so it is the submission as it was made and stays that way however
  // the job is later edited — the audit table cannot be rewritten.
  const submitted = submittedDetails(events);

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
      <Link
        href="/jobs"
        className="text-sm text-ink-faint underline underline-offset-2
                   transition-colors hover:text-ink-soft"
      >
        ← All jobs
      </Link>

      <div className="mt-4 rounded-xl border border-line bg-surface p-6 shadow-card">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-xs tabular-nums text-ink-faint">
            {job.ref}
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-ink text-balance">
            {job.title}
          </h1>
        </div>

        <dl className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
            <dt className="text-sm text-ink-faint">Status</dt>
            <dd className="text-sm text-ink">{job.status.replace(/_/g, " ")}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
            <dt className="text-sm text-ink-faint">Direction</dt>
            <dd className="text-sm text-ink">
              {job.direction === "from_client" ? "Client → us" : "Us → client"}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
            <dt className="text-sm text-ink-faint">Due</dt>
            <dd className="text-sm tabular-nums text-ink">
              {job.dueAt ? new Date(job.dueAt).toISOString().slice(0, 10) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
            <dt className="text-sm text-ink-faint">Raised</dt>
            <dd className="text-sm tabular-nums text-ink">
              {new Date(job.createdAt).toISOString().slice(0, 10)}
            </dd>
          </div>
        </dl>

        {canWrite ? (
          <form action={setJobStatusAction} className="mt-6 flex flex-wrap items-center gap-2">
            <input type="hidden" name="jobId" value={job.id} />
            <label htmlFor="status" className="text-sm text-ink-soft">
              Change status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={job.status}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink
                         focus:border-brand focus:outline-2 focus:outline-brand/30"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg bg-brand-surface px-3 py-1.5 text-sm font-semibold text-brand-on-surface
                         transition-colors duration-150 hover:bg-brand-surface-hover
                         focus-visible:outline-2 focus-visible:outline-offset-2
                         focus-visible:outline-brand"
            >
              Update
            </button>
          </form>
        ) : null}
      </div>

      {submitted ? (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-ink">
            Submitted details
          </h2>
          <dl className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {Object.entries(submitted).map(([label, value]) => (
              <div
                key={label}
                className="grid gap-1 border-b border-line-soft px-5 py-3 last:border-b-0
                           sm:grid-cols-[minmax(0,1fr)_minmax(0,2.5fr)] sm:gap-4"
              >
                <dt className="text-xs uppercase tracking-wider text-ink-faint">
                  {label.replace(/_/g, " ")}
                </dt>
                <dd className="min-w-0 text-sm whitespace-pre-wrap text-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-ink-faint">
            Exactly as it arrived, from the creation record. Nothing here has
            been interpreted as an instruction — it is text somebody typed into a
            form on a public website.
          </p>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">History</h2>
        <ol className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {events.map((event) => (
            <li
              key={String(event.id)}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b
                         border-line-soft px-4 py-2.5 last:border-b-0"
            >
              <span className="w-40 flex-none font-mono text-xs tabular-nums text-ink-faint">
                {new Date(event.createdAt).toISOString().replace("T", " ").slice(0, 19)}
              </span>
              <span className="flex-none text-sm text-ink">
                {event.action.replace(/_/g, " ")}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                {event.actorEmailAtTime}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-ink-faint">
          Append-only. The application role can insert and read these rows and
          nothing else, so an attempt to rewrite history fails at the database.
        </p>
      </section>
    </PortalShell>
  );
}
