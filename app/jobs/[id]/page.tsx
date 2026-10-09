import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getJob, listJobEvents, listJobNotes } from "@/lib/db";
import { teamFor } from "@/lib/db/identity";
import { z } from "zod";
import { requirePage } from "@/lib/auth/authorize";
import { allows, JOB_KIND_LABELS, JOB_KINDS, statusesFor } from "@/lib/auth/permissions";
import { PortalShell } from "../../portal-shell";
import { CsrfField } from "../../_components/csrf-field";
import { JobKindBadge } from "../../_components/job-kind";
import { NotesThread } from "../../_components/notes-thread";
import { SubmitButton } from "../../_components/submit-button";
import { postJobNoteAction, setJobKindAction, setJobStatusAction } from "../actions";

export const metadata: Metadata = { title: "Job" };

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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { id } = await params;
  const { error, notice } = await searchParams;
  // The id is input from the address bar: anything that is not a uuid cannot
  // name a job, and is the same 404 as one that does not exist.
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, role, via, businessId } = await requirePage("jobs.read", {
    returnPath: `/jobs/${id}`,
    resource: { type: "job", id },
  });

  const job = await getJob(ctx.scope, id);
  if (!job) notFound();

  const [events, notes, team] = await Promise.all([
    listJobEvents(ctx.scope, id),
    listJobNotes(ctx.scope, id),
    teamFor(businessId),
  ]);

  // Names for the people of this business. Somebody who has since left is
  // shown by the address they wrote under, which the note keeps.
  const people = team.filter((p) => !p.isService);
  const nameOf = (userId: string | null, fallback = "Somebody who has left") => {
    const person = team.find((p) => p.userId === userId);
    return person ? person.fullName || person.email : fallback;
  };
  const mayNote = allows(role, "jobs.note", via);
  const mayAssign = allows(role, "jobs.assign", via);

  // What the sender filled in, if this job arrived from a form rather than from
  // these screens. It is read off the creation event rather than from columns on
  // the job, so it is the submission as it was made and stays that way however
  // the job is later edited — the audit table cannot be rewritten.
  const submitted = submittedDetails(events);

  // Only the moves this role may make from where the job is now: a decision
  // (approve, ask for changes, cancel, or undo one) is an owner's or a
  // manager's. The action checks the same rule again on submit.
  const statuses = statusesFor(role, job.status).filter((s) => s !== "draft" || s === job.status);
  const canWrite = statuses.some((s) => s !== job.status);
  // Quote, estimate or job: moving the work along, like a status change.
  const mayChangeKind = allows(role, "jobs.update_status", via);

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={null}
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
          <JobKindBadge kind={job.kind} className="self-center" />
          <span className="font-mono text-xs tabular-nums text-ink-faint">
            {job.ref}
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-ink text-balance">
            {job.title}
          </h1>
        </div>

        <dl className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-4 border-b border-line-soft pb-2 sm:col-span-2">
            <dt className="text-sm text-ink-faint">Type</dt>
            <dd className="text-sm text-ink">
              {mayChangeKind ? (
                <form action={setJobKindAction} className="flex gap-1 rounded-lg bg-sunk p-1">
                  <CsrfField />
                  <input type="hidden" name="jobId" value={job.id} />
                  <input type="hidden" name="from" value={job.kind} />
                  {JOB_KINDS.map((k) => (
                    <button
                      key={k}
                      type="submit"
                      name="kind"
                      value={k}
                      aria-pressed={k === job.kind}
                      disabled={k === job.kind}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors duration-150
                                  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                                    k === job.kind
                                      ? "bg-surface text-ink shadow-card"
                                      : "text-ink-soft hover:text-ink"
                                  }`}
                    >
                      {JOB_KIND_LABELS[k]}
                    </button>
                  ))}
                </form>
              ) : (
                JOB_KIND_LABELS[job.kind]
              )}
            </dd>
          </div>
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
            <dt className="text-sm text-ink-faint">Assigned to</dt>
            <dd className="text-sm text-ink">
              {job.assignedTo
                ? job.assignedTo === ctx.userId
                  ? "You"
                  : nameOf(job.assignedTo, "Somebody no longer here")
                : "Nobody yet"}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
            <dt className="text-sm text-ink-faint">Raised</dt>
            <dd className="text-sm tabular-nums text-ink">
              {new Date(job.createdAt).toISOString().slice(0, 10)}
            </dd>
          </div>
        </dl>

        {error === "moved" ? (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
          >
            Somebody changed this job while you were looking at it, so your change
            was not made. It is shown as it is now.
          </p>
        ) : null}

        {canWrite ? (
          <form action={setJobStatusAction} className="mt-6 flex flex-wrap items-center gap-2">
            <CsrfField />
            <input type="hidden" name="jobId" value={job.id} />
            <input type="hidden" name="from" value={job.status} />
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
              {statuses.map((s) => (
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

      <NotesThread
        notes={notes.map((note) => ({
          id: note.id,
          author: note.authorId === ctx.userId ? "You" : nameOf(note.authorId, note.authorEmailAtTime),
          at: new Date(note.createdAt),
          body: note.body,
          handedTo: note.handedTo
            ? note.handedTo === ctx.userId
              ? "you"
              : nameOf(note.handedTo, "somebody no longer here")
            : null,
        }))}
      >
        {mayNote || mayAssign ? (
          <form action={postJobNoteAction} className="grid gap-3">
            <CsrfField />
            <input type="hidden" name="jobId" value={job.id} />
            <input type="hidden" name="from" value={job.assignedTo ?? ""} />
            {error === "note" ? (
              <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
                Write a note, or choose somebody to hand this to. A note can be up to 4,000 characters.
              </p>
            ) : error === "person" ? (
              <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
                That person is not on this business&rsquo;s team, so the job was not handed over.
              </p>
            ) : notice === "mail" ? (
              <p role="status" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink">
                Handed over, but the email to them did not send. It is under &ldquo;Assigned to me&rdquo; on their Jobs page.
              </p>
            ) : null}
            <label htmlFor="note-body" className="sr-only">
              Note
            </label>
            <textarea
              id="note-body"
              name="body"
              rows={3}
              maxLength={4000}
              placeholder={mayNote ? "Write a note for the team…" : "Add a note to go with it (optional)…"}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink
                         placeholder:text-ink-faint focus:border-brand focus:outline-2 focus:outline-brand/30"
            />
            <div className="flex flex-wrap items-center gap-2">
              {mayAssign ? (
                <>
                  <label htmlFor="hand-to" className="text-sm text-ink-soft">
                    Hand to
                  </label>
                  <select
                    id="hand-to"
                    name="handTo"
                    defaultValue="keep"
                    className="min-w-0 max-w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink
                               focus:border-brand focus:outline-2 focus:outline-brand/30"
                  >
                    <option value="keep">
                      {job.assignedTo
                        ? `Keep with ${job.assignedTo === ctx.userId ? "me" : nameOf(job.assignedTo, "them")}`
                        : "Nobody (just a note)"}
                    </option>
                    {people
                      .filter((p) => p.userId !== job.assignedTo)
                      .map((p) => (
                        <option key={p.userId} value={p.userId}>
                          {p.userId === ctx.userId ? `Me (${p.fullName || p.email})` : p.fullName || p.email}
                        </option>
                      ))}
                    {job.assignedTo ? <option value="nobody">Nobody: take it off them</option> : null}
                  </select>
                </>
              ) : (
                <input type="hidden" name="handTo" value="keep" />
              )}
              <SubmitButton
                pendingLabel="Sending…"
                className="ml-auto rounded-lg bg-brand-surface px-4 py-1.5 text-sm font-semibold text-brand-on-surface
                           transition-colors duration-150 hover:bg-brand-surface-hover disabled:opacity-60
                           focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Send
              </SubmitButton>
            </div>
          </form>
        ) : null}
      </NotesThread>

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
