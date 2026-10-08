import type { ReactNode } from "react";
import { Icon } from "./icons";
import type { ComingSoon } from "./sections";

/**
 * The body of a section that is in the navigation but not built yet.
 *
 * It says what the screen will be, plainly, and shows nothing that looks like
 * data: an empty table or a row of zeroes would read as "you have no orders",
 * which is a claim about the business, not about the portal.
 */
export function ComingSoonPage({ section, children }: { section: ComingSoon; children?: ReactNode }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{section.label}</h1>
        <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">Coming soon</span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">{section.blurb}</p>

      <div className="mt-8 rounded-2xl border border-line bg-surface p-8 text-center shadow-card sm:p-12">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-sunk text-ink-soft">
          <Icon name={section.icon} className="h-7 w-7" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-ink">{section.label} is on its way</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
          This part of 10XiD isn’t built yet. When it is, it will hold:
        </p>
        <ul className="mx-auto mt-5 grid max-w-md gap-2 text-left">
          {section.plans.map((plan) => (
            <li key={plan} className="flex items-center gap-2.5 rounded-lg bg-sunk px-3 py-2 text-sm text-ink">
              <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-brand" />
              {plan}
            </li>
          ))}
        </ul>
      </div>

      {children}
    </>
  );
}
