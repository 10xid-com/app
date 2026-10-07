"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createJob, ScopeError, setJobStatus } from "@/lib/db";
import { requireAction } from "@/lib/auth/authorize";

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
  status: z.enum([
    "draft",
    "open",
    "in_progress",
    "awaiting_approval",
    "changes_requested",
    "approved",
    "completed",
    "cancelled",
  ]),
});

export async function setJobStatusAction(formData: FormData) {
  const parsed = statusSchema.safeParse({
    jobId: formData.get("jobId"),
    status: formData.get("status"),
  });
  if (!parsed.success) redirect("/jobs");

  const { ctx } = await requireAction("jobs.update_status", formData, {
    returnPath: `/jobs/${parsed.data.jobId}`,
    resource: { type: "job", id: parsed.data.jobId },
  });

  try {
    // The central function has already checked the job belongs to this
    // business; row-level security would refuse it underneath regardless.
    await setJobStatus(ctx.scope, parsed.data.jobId, parsed.data.status);
  } catch (error) {
    if (error instanceof ScopeError) redirect("/jobs?error=noclient");
    throw error;
  }

  revalidatePath("/jobs");
  redirect(`/jobs/${parsed.data.jobId}`);
}
