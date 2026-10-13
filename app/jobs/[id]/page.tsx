import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePage } from "@/lib/auth/authorize";
import { WorkDetail } from "./work-detail";

export const metadata: Metadata = { title: "Job" };

/**
 * One job, addressed by the id in the URL.
 *
 * This is the page the isolation test attacks: signed in as one client, ask for
 * another client's job by its exact id. The answer is a 404 from WorkDetail,
 * the same as for an id that never existed.
 */
export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  // The id is input from the address bar: anything that is not a uuid cannot
  // name a job, and is the same 404 as one that does not exist.
  if (!z.uuid().safeParse(id).success) notFound();
  const grant = await requirePage("jobs.read", {
    returnPath: `/jobs/${id}`,
    resource: { type: "job", id },
  });

  return <WorkDetail section="jobs" id={id} error={error} grant={grant} />;
}
