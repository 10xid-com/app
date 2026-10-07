import type { Metadata } from "next";
import { requireSignedIn } from "@/lib/auth/authorize";
import { ROLE_LABELS, isRoleTemplate } from "@/lib/auth/permissions";
import { PortalShell } from "../portal-shell";
import { CsrfField } from "../_components/csrf-field";
import { switchBusinessAction } from "./actions";

export const metadata: Metadata = { title: "Your businesses" };

/**
 * The business switcher.
 *
 * Every client business the signed-in person belongs to, with their role in
 * each, and the one on screen marked. Somebody with several businesses and
 * none chosen is sent here by every page; somebody with one never needs it.
 *
 * It shows only the person's own memberships — no business data — which is
 * why it needs a signed-in session and not a business (requireSignedIn).
 */
export default async function BusinessPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await requireSignedIn("/business");
  const { error } = await searchParams;

  const businesses = ctx.memberships
    .filter((m) => m.organizationType === "client")
    .sort((a, b) => a.organizationName.localeCompare(b.organizationName));
  const current = ctx.scope.organizationId;

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Your businesses</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        {businesses.length === 0
          ? "Your account isn't attached to any business yet. Ask an owner of the business to invite this address."
          : current
            ? "Choose which business to work in. What you can do in each depends on your role there."
            : "You work with more than one business. Choose which one to open; you can switch at any time from the menu."}
      </p>

      {error === "not_yours" ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
        >
          You are not a member of that business, so it cannot be opened.
        </p>
      ) : null}

      {businesses.length > 0 ? (
        <ul className="mt-6 divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {businesses.map((b) => {
            const open = b.organizationId === current;
            return (
              <li key={b.organizationId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {b.organizationName}
                    {open ? (
                      <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
                        open now
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {isRoleTemplate(b.role) ? ROLE_LABELS[b.role] : b.role}
                  </p>
                </div>
                {open ? null : (
                  <form action={switchBusinessAction} className="flex-none">
                    <CsrfField />
                    <input type="hidden" name="organizationId" value={b.organizationId} />
                    <button
                      type="submit"
                      className="rounded-lg bg-brand-surface px-3 py-1.5 text-sm font-semibold text-brand-on-surface
                                 transition-colors duration-150 hover:bg-brand-surface-hover
                                 focus-visible:outline-2 focus-visible:outline-offset-2
                                 focus-visible:outline-brand"
                    >
                      Open
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </PortalShell>
  );
}
