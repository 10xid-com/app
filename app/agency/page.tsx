import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/authorize";
import { ROLE_LABELS, ROLE_TEMPLATES, isRoleTemplate } from "@/lib/auth/permissions";
import { agencyPeople, grantsForAgency } from "@/lib/db/agency";
import { organizationById } from "@/lib/db/identity";
import { PortalShell } from "../portal-shell";
import { CsrfField } from "../_components/csrf-field";
import {
  addAgencyPersonAction,
  removeAgencyPersonAction,
  renewGrantAction,
  requestAccessAction,
  withdrawGrantAction,
} from "./actions";

export const metadata: Metadata = { title: "Agency" };

/**
 * The agency's side of agency access: ask a business for access, name your
 * people on it, take them off, withdraw.
 *
 * Only for an organization that is an agency (Branding Centres, to begin
 * with), with it open, as its owner or manager. Asking grants nothing: the
 * business's owner decides on the grant and on each person you name.
 */

const NOTICES: Record<string, string> = {
  asked: "Asked. If that reference is a business on 10XiD, its owners have been told; nothing opens until they approve.",
  named: "Named. They can open the business once its owner approves them.",
  removed: "Taken off.",
  withdrawn: "Withdrawn.",
  renewal:
    "Asked to renew, with your people named again. Nothing changes until the business's owner approves the renewal and each person; your current access runs to its end date.",
};
const ERRORS: Record<string, string> = {
  refused: "That was refused: check the reference, the role, the days (at most 365) and the reason (at least 8 characters).",
  already_open:
    "You already have a request waiting with that business, access with more than seven days to run (renewal opens in its last seven days), or that person is already named.",
  not_found: "That is no longer open.",
};

const AGENCY_ROLES = ROLE_TEMPLATES.filter((r) => r !== "owner");
const day = (d: Date) => d.toISOString().slice(0, 10);
const roleName = (r: string) => (isRoleTemplate(r) ? ROLE_LABELS[r] : r);
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-2 focus:outline-brand/30";
const small =
  "rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export default async function AgencyPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; error?: string }>;
}) {
  const { ctx, businessId } = await requirePage("staff.manage", { returnPath: "/agency" });
  const agency = await organizationById(businessId);
  if (!agency?.isAgency) notFound();
  const params = await searchParams;
  const [grants, people] = await Promise.all([grantsForAgency(agency.id), agencyPeople(agency.id)]);

  return (
    <PortalShell email={ctx.email} isStaff={false} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Agency</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        Work on other businesses as {agency.name}. Ask a business for access, then name the people who will do the work;
        its owner approves the access and each person, for a fixed time. Your people never become its members.
      </p>

      {params.done && NOTICES[params.done] ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          {NOTICES[params.done]}
        </p>
      ) : null}
      {params.error ? (
        <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {ERRORS[params.error] ?? "That did not work."}
        </p>
      ) : null}

      <form action={requestAccessAction}
        className="mt-6 grid gap-3 rounded-xl border border-line bg-surface p-4 shadow-card sm:grid-cols-2">
        <CsrfField />
        <label className="text-xs font-medium text-ink-soft sm:col-span-2">
          Business reference
          <input name="businessRef" required maxLength={100} placeholder="e.g. vinyl-wrap-toronto"
            className={`mt-1 w-full ${field}`} />
          <span className="mt-1 block font-normal text-ink-faint">Ask the business for its 10XiD reference.</span>
        </label>
        <label className="text-xs font-medium text-ink-soft">
          Role
          <select name="role" defaultValue="editor" className={`mt-1 w-full ${field}`}>
            {AGENCY_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-soft">
          Days (at most 365)
          <input name="days" type="number" min={1} max={365} defaultValue={90} className={`mt-1 w-full ${field}`} />
        </label>
        <label className="text-xs font-medium text-ink-soft sm:col-span-2">
          Why
          <input name="reason" required minLength={8} maxLength={500} placeholder="What you will be doing for them"
            className={`mt-1 w-full ${field}`} />
        </label>
        <div className="sm:col-span-2">
          <button type="submit"
            className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            Ask for access
          </button>
        </div>
      </form>

      <h2 className="mt-8 text-sm font-semibold text-ink">Your access</h2>
      {grants.length === 0 ? <p className="mt-2 text-sm text-ink-faint">You have not asked any business yet.</p> : null}
      <ul className="mt-2 space-y-3">
        {grants.map((g) => {
          const live = g.live;
          const open = g.status === "requested" || live;
          const waiting = grants.some((o) => o.status === "requested" && o.otherOrganizationId === g.otherOrganizationId);
          const state =
            g.status === "requested"
              ? g.renewsGrantId
                ? "renewal, waiting for the business"
                : "waiting for the business"
              : live
                ? `in force until ${day(g.expiresAt!)}`
                : g.status === "active"
                  ? `ended ${day(g.expiresAt!)}`
                  : g.status;
          const named = new Set(g.people.filter((p) => p.status !== "removed" && p.status !== "declined").map((p) => p.userId));
          return (
            <li key={g.id} id={`grant-${g.id}`} className="rounded-xl border border-line bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-ink">
                  {g.otherName} · {roleName(g.role)} · {state}
                </p>
                {g.renewable && !waiting ? (
                  <form action={renewGrantAction}>
                    <CsrfField />
                    <input type="hidden" name="grantId" value={g.id} />
                    <button type="submit" className={small}>
                      Ask to renew
                    </button>
                  </form>
                ) : null}
                {open ? (
                  <form action={withdrawGrantAction}>
                    <CsrfField />
                    <input type="hidden" name="grantId" value={g.id} />
                    <button type="submit" className={small}>
                      {g.status === "requested" ? "Withdraw" : "End our access"}
                    </button>
                  </form>
                ) : null}
              </div>
              <ul className="mt-2 divide-y divide-line-soft">
                {g.people.map((p) => (
                  <li key={p.userId} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="text-ink">
                      {p.email} <span className="text-xs text-ink-faint">· {p.status}</span>
                    </span>
                    {open && (p.status === "requested" || p.status === "approved" || p.status === "blocked") ? (
                      <form action={removeAgencyPersonAction}>
                        <CsrfField />
                        <input type="hidden" name="grantId" value={g.id} />
                        <input type="hidden" name="userId" value={p.userId} />
                        <button type="submit" className={small}>
                          Take off
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
              {open ? (
                <form action={addAgencyPersonAction} className="mt-2 flex flex-wrap items-center gap-2">
                  <CsrfField />
                  <input type="hidden" name="grantId" value={g.id} />
                  <label className="sr-only" htmlFor={`person-${g.id}`}>
                    Person
                  </label>
                  <select id={`person-${g.id}`} name="userId" required defaultValue="" className={field}>
                    <option value="" disabled>
                      Name a person…
                    </option>
                    {people
                      .filter((p) => !named.has(p.userId))
                      .map((p) => (
                        <option key={p.userId} value={p.userId}>
                          {p.fullName ? `${p.fullName} (${p.email})` : p.email}
                        </option>
                      ))}
                  </select>
                  <button type="submit" className={small}>
                    Name
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </PortalShell>
  );
}
