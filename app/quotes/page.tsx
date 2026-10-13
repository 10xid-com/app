import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/authorize";
import { WorkList } from "../jobs/work-list";

export const metadata: Metadata = { title: "Quotes" };

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; view?: string; type?: string }>;
}) {
  const grant = await requirePage("jobs.read", { returnPath: "/quotes" });
  return <WorkList section="quotes" grant={grant} params={await searchParams} />;
}
