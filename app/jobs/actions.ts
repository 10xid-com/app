"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createJob, ScopeError, setJobStatus } from "@/lib/db";
import { requireAction } from "@/lib/auth/authorize";
import { JOB_STATUSES, statusChangeAction } from "@/lib/auth/permissions";

const newJobSchema = z.object({
  title: z.string().trim().min(3).max(200),
  direction: z.enum(["from_client", "to_client"]),
  dueAt: z.string().trim().optional(),
});

export async function createJobAction(formData: FormData) {
  const { ctx } = await requireAction("jobs.create", formData, { returnPath: "/jobs" });

  const parsed = newJobSchema.safeParse({
    title: formData.get("title"),
    direction: formData.get("direction"),
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
