import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requirePage } from "@/lib/auth/authorize";
import { SECTION_KINDS } from "./section";
import { WorkList } from "./work-list";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; view?: string; type?: string }>;
}) {
  const grant = await requirePage("jobs.read", { returnPath: "/jobs" });
  const params = await searchParams;

  // Quotes and estimates were once a filter here. An address from then goes to
  // their own section, filter and all.
  if (SECTION_KINDS.quotes.some((k) => k === params.type)) {
    const q = new URLSearchParams({ type: params.type! });
    if (params.view === "mine") q.set("view", "mine");
    redirect(`/quotes?${q}`);
  }

  return <WorkList section="jobs" grant={grant} params={params} />;
}
