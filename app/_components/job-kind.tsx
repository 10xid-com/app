import { JOB_KIND_LABELS, type JobKind } from "@/lib/auth/permissions";

/** Quote, estimate, job: an outline in the colour of where the work is. */
const KIND_STYLE: Record<JobKind, string> = {
  quote: "border-brand/40 text-brand",
  estimate: "border-warn/50 text-warn",
  job: "border-line text-ink-soft",
};

export function JobKindBadge({ kind, className = "" }: { kind: JobKind; className?: string }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-center text-xs font-medium ${KIND_STYLE[kind]} ${className}`}>
      {JOB_KIND_LABELS[kind]}
    </span>
  );
}
