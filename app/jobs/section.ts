import type { JobKind } from "@/lib/auth/permissions";

/**
 * Jobs and Quotes are separate sections of the nav: the work being done, and
 * the work still being priced. They hold the same rows (a quote the customer
 * accepts becomes a job), so a row's kind decides which section it is in, and
 * it moves across when its kind changes.
 */
export type Section = "jobs" | "quotes";

export const SECTION_KINDS = {
  jobs: ["job"],
  quotes: ["quote", "estimate"],
} as const satisfies Record<Section, readonly JobKind[]>;

export const sectionOf = (kind: JobKind): Section => (kind === "job" ? "jobs" : "quotes");

/** Where a row lives: its section's list, or its own page in that section. */
export const workPath = (kind: JobKind, id?: string) => `/${sectionOf(kind)}${id ? `/${id}` : ""}`;
