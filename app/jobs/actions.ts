"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addJobNote, createJob, handOverJob, ScopeError, setJobKind, setJobStatus } from "@/lib/db";
import { organizationById, teamFor } from "@/lib/db/identity";
import { requireAction } from "@/lib/auth/authorize";
import { sendHandoverNotice } from "@/lib/auth/mailer";
import { appOrigin } from "@/lib/auth/origin";
import { JOB_KINDS, JOB_STATUSES, statusChangeAction } from "@/lib/auth/permissions";

const newJobSchema = z.object({
  title: z.string().trim().min(3).max(200),
  direction: z.enum(["from_client", "to_client"]),
  kind: z.enum(JOB_KINDS).default("job"),
  dueAt: z.string().trim().optional(),
});

export async function createJobAction(formData: FormData) {
  const { ctx } = await requireAction("jobs.create", formData, { returnPath: "/jobs" });

  const parsed = newJobSchema.safeParse({
    title: formData.get("title"),
    direction: formData.get("direction"),
    kind: formData.get("kind") ?? undefined,
    dueAt: formData.get("dueAt") ?? undefined,
  });

  if (!parsed.success) redirect("/jobs?error=title");

  const due = parsed.data.dueAt ? new Date(parsed.data.dueAt) : null;

  try {
    // The scope comes from the session. Which company the job belongs to is
    // never taken from the form — a client cannot file a job into somebody
    // else's company by editing a hidden field, because there is no field.
    await createJob(ctx.scope, {
      title: parsed.data.title,
      direction: parsed.data.direction,
      kind: parsed.data.kind,
      dueAt: due && !Number.isNaN(due.getTime()) ? due : null,
    });
  } catch (error) {
    if (error instanceof ScopeError) redirect("/jobs?error=noclient");
    throw error;
  }

  revalidatePath("/jobs");
  redirect("/jobs");
}

const statusSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(JOB_STATUSES),
  /** The status the person was looking at. Which move this is decides who may make it. */
  from: z.enum(JOB_STATUSES),
});

export async function setJobStatusAction(formData: FormData) {
  const parsed = statusSchema.safeParse({
    jobId: formData.get("jobId"),
    status: formData.get("status"),
    from: formData.get("from"),
  });
  if (!parsed.success) redirect("/jobs");
  const { jobId, status, from } = parsed.data;
  if (status === from) redirect(`/jobs/${jobId}`);

  // Approving, asking for changes, cancelling, or undoing one of those, is
  // `jobs.approve` — owners and managers. `from` comes from the form, so the
  // write below only applies if the job is still exactly there: claiming a
  // different starting point cannot buy a cheaper permission.
  const { ctx } = await requireAction(statusChangeAction(from, status), formData, {
    returnPath: `/jobs/${jobId}`,
    resource: { type: "job", id: jobId },
  });

  let changed;
  try {
    // The central function has already checked the job belongs to this
    // business; row-level security would refuse it underneath regardless.
    changed = await setJobStatus(ctx.scope, jobId, status, from);
  } catch (error) {
    if (error instanceof ScopeError) redirect("/jobs?error=noclient");
    throw error;
  }

  revalidatePath("/jobs");
  redirect(changed ? `/jobs/${jobId}` : `/jobs/${jobId}?error=moved`);
}

const kindSchema = z.object({
  jobId: z.uuid(),
  kind: z.enum(JOB_KINDS),
  /** The kind the person was looking at. The change only applies if it still is. */
  from: z.enum(JOB_KINDS),
});

/** Quote, estimate or job: moving the work along, so `jobs.update_status`. */
export async function setJobKindAction(formData: FormData) {
  const parsed = kindSchema.safeParse({
    jobId: formData.get("jobId"),
    kind: formData.get("kind"),
    from: formData.get("from"),
  });
  if (!parsed.success) redirect("/jobs");
  const { jobId, kind, from } = parsed.data;
  if (kind === from) redirect(`/jobs/${jobId}`);

  const { ctx } = await requireAction("jobs.update_status", formData, {
    returnPath: `/jobs/${jobId}`,
    resource: { type: "job", id: jobId },
  });

  let changed;
  try {
    changed = await setJobKind(ctx.scope, jobId, kind, from);
  } catch (error) {
    if (error instanceof ScopeError) redirect("/jobs?error=noclient");
    throw error;
  }

  revalidatePath("/jobs");
  redirect(changed ? `/jobs/${jobId}` : `/jobs/${jobId}?error=moved`);
}

/** "keep" leaves the job with whoever has it; "nobody" takes it off them. */
const noteSchema = z.object({
  jobId: z.uuid(),
  body: z.string().trim().max(4000),
  handTo: z.union([z.literal("keep"), z.literal("nobody"), z.uuid()]),
  /** Who had the job when the person looked. A handover only applies if they still do. */
  from: z.union([z.literal(""), z.uuid()]),
});

/** What the notes box hears back: nothing (it worked), or a sentence. */
export type NoteState = { error: string | null; notice: string | null; at: number };

const NOTE_ERRORS = {
  note: "Write a note, or choose somebody to hand this to. A note can be up to 4,000 characters.",
  person: "That person is not on this business\u2019s team, so the job was not handed over.",
  moved: "Somebody changed who has this job while you were looking, so it was not handed over. It is shown as it is now.",
  gone: "This job is no longer there.",
} as const;

const said = (error: keyof typeof NOTE_ERRORS | null, notice: string | null = null): NoteState => ({
  error: error ? NOTE_ERRORS[error] : null,
  notice,
  at: Date.now(),
});

/**
 * The job page's one box: write a note, hand the job to a teammate, or both.
 *
 * Handing over needs `jobs.assign`; a note on its own needs `jobs.note`.
 * Who the job goes to is checked against the business's people here, so a
 * mistake is a sentence; the database refuses anybody else regardless
 * (login's 0031).
 *
 * It answers the page rather than redirecting: the box (./[id]/notes.tsx)
 * shows the note the moment Send is pressed and this replaces it with the
 * real one, so nobody watches a button say "Sending…". The page refreshes
 * through revalidatePath in this same response.
 */
export async function sendJobNoteAction(_prev: NoteState, formData: FormData): Promise<NoteState> {
  const parsed = noteSchema.safeParse({
    jobId: formData.get("jobId"),
    body: formData.get("body") ?? "",
    handTo: formData.get("handTo") ?? "keep",
    from: formData.get("from") ?? "",
  });
  if (!parsed.success) return said("note");
  const { jobId, body } = parsed.data;
  const from = parsed.data.from || null;
  const to = parsed.data.handTo === "keep" ? from : parsed.data.handTo === "nobody" ? null : parsed.data.handTo;
  const page = `/jobs/${jobId}`;

  // Nothing changes hands: this is a note, and a note needs words.
  if (to === from) {
    if (!body) return said("note");
    const { ctx } = await requireAction("jobs.note", formData, {
      returnPath: page,
      resource: { type: "job", id: jobId },
    });
    try {
      if (!(await addJobNote(ctx.scope, jobId, body))) return said("gone");
    } catch (error) {
      if (error instanceof ScopeError) redirect("/jobs?error=noclient");
      throw error;
    }
    revalidatePath(page);
    return said(null);
  }

  const { ctx, businessId } = await requireAction("jobs.assign", formData, {
    returnPath: page,
    resource: { type: "job", id: jobId },
  });

  const people = (await teamFor(businessId)).filter((p) => !p.isService);
  const recipient = to ? people.find((p) => p.userId === to) : null;
  if (to && !recipient) return said("person");

  let handed;
  try {
    handed = await handOverJob(ctx.scope, jobId, { to, from, note: body || null });
  } catch (error) {
    if (error instanceof ScopeError) redirect("/jobs?error=noclient");
    throw error;
  }
  revalidatePath(page);
  revalidatePath("/jobs");
  if (!handed) return said("moved");

  // Handing a job to yourself needs no email.
  if (recipient && recipient.userId !== ctx.userId) {
    const sender = people.find((p) => p.userId === ctx.userId);
    try {
      await sendHandoverNotice({
        to: recipient.email,
        fromName: sender?.fullName || ctx.email,
        businessName: (await organizationById(businessId))?.name ?? "your business",
        jobRef: handed.job.ref,
        jobTitle: handed.job.title,
        note: handed.note?.body ?? null,
        jobUrl: `${appOrigin() ?? ""}${page}`,
      });
    } catch (cause) {
      // The handover stands; the email is a courtesy, and the job is under
      // "Assigned to me" either way.
      console.error("[jobs] handover notice did not send:", cause instanceof Error ? cause.message : cause);
      return said(
        null,
        `Handed over, but the email to ${recipient.fullName || recipient.email} did not send. It is under \u201cAssigned to me\u201d on their Jobs page.`,
      );
    }
  }

  return said(null);
}
