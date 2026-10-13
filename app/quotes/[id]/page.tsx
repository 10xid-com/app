import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePage } from "@/lib/auth/authorize";
import { WorkDetail } from "../../jobs/[id]/work-detail";

export const metadata: Metadata = { title: "Quote" };

/** One quote or estimate. Same rows and the same checks as /jobs/[id]. */
export default async function QuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const grant = await requirePage("jobs.read", {
    returnPath: `/quotes/${id}`,
    resource: { type: "job", id },
  });

  return <WorkDetail section="quotes" id={id} error={error} grant={grant} />;
}
