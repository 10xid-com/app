"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createJob, ScopeError, setJobStatus } from "@/lib/db";
import { requireSession } from "@/lib/auth/require";

const newJobSchema = z.object({
  title: z.string().trim().min(3).max(200),
  direction: z.enum(["from_client", "to_client"]),
  dueAt: z.string().trim().optional(),
});

export async function createJobAction(formData: FormData) {
  const ctx = await requireSession("/jobs");

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
  const ctx = await requireSession("/jobs");

  const parsed = statusSchema.safeParse({
    jobId: formData.get("jobId"),
    status: formData.get("status"),
  });
  if (!parsed.success) redirect("/jobs");

  try {
    // Note there is no ownership check written here. The job is simply not
    // visible to a caller outside its company, so this updates nothing and
    // returns null — the same answer as for an id that never existed.
    await setJobStatus(ctx.scope, parsed.data.jobId, parsed.data.status);
  } catch (error) {
    if (error instanceof ScopeError) redirect("/jobs?error=noclient");
    throw error;
  }

  revalidatePath("/jobs");
  redirect(`/jobs/${parsed.data.jobId}`);
}
