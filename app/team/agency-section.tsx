import { ROLE_LABELS, ROLE_TEMPLATES, isRoleTemplate } from "@/lib/auth/permissions";
import type { GrantSummary } from "@/lib/db/agency";
import type { AuditRow } from "@/lib/db/audit";
import { CsrfField } from "../_components/csrf-field";
import {
  approveGrantAction,
  decideAgencyPersonAction,
  declineGrantAction,
  revokeGrantAction,
} from "./agency-actions";

/**
 * "Agency access" on the Team page: who outside the business can reach it,
 * through which agency, as what, and until when — and the decisions waiting.
 *
 * Shown to owners and managers. Owners approve and decline (grants and
 * people); managers can block a person or end a grant, never widen anything.
 */

const button =
  "rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-sunk " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const primary =
  "rounded-md bg-brand-surface px-2.5 py-1 text-xs font-semibold text-brand-on-surface hover:bg-brand-surface-hover " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const danger =
  "rounded-md border border-bad/40 px-2.5 py-1 text-xs font-medium text-bad hover:bg-bad/5 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const AGENCY_ROLES = ROLE_TEMPLATES.filter((r) => r !== "owner");
const day = (d: Date) => d.toISOString().slice(0, 10);
const roleName = (r: string) => (isRoleTemplate(r) ? ROLE_LABELS[r] : r);

export const AGENCY_NOTICES: Record<string, string> = {
  approved: "Approved. The people you approve on it can open this business until its end date.",
  declined: "Declined.",
  revoked: "Ended. Nobody from that agency can open this business any more.",
  person_approved: "Approved. They can open this business while the grant is in force.",
  person_declined: "Declined.",
  person_blocked: "Blocked. They lose access on their next click.",
};

export const AGENCY_ERRORS: Record<string, string> = {
  not_found: "That is no longer waiting for a decision here.",
  refused: "That was refused: check the role and the number of days (no longer than was asked).",
  already_open: "There is already an open grant for that agency.",
};

const ACTIVITY: Record<string, string> = {
  "agency.grant.requested": "asked for access",
  "agency.grant.approved": "approved access",
  "agency.grant.declined": "declined access",
  "agency.grant.revoked": "ended access",
  "agency.grant.withdrawn": "withdrew access",
  "agency.person.named": "named",
  "agency.person.approved": "approved",
  "agency.person.declined": "declined",
  "agency.person.blocked": "blocked",
  "agency.person.unblocked": "unblocked",
  "agency.person.removed": "took off",
  "agency.acted": "through agency access:",
};

function Activity({ rows, grants }: { rows: AuditRow[]; grants: GrantSummary[] }) {
  const emails = new Map(grants.flatMap((g) => g.people.map((p) => [p.userId, p.email] as const)));
  const agencyOf = new Map(grants.map((g) => [g.id, g.otherName] as const));
  const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
  // A person's id reads as their address; a grant's terms ("editor, 30 days") in brackets.
  const target = (r: AuditRow) =>
    !r.target
      ? null
      : (emails.get(r.target) ??
        (r.action.startsWith("agency.grant.") ? `(${r.target.replace(/^\w+/, (role) => roleName(role))})` : r.target));
  return (
    <details className="mt-4 rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-ink-soft">Agency activity</summary>
      <ul className="divide-y divide-line-soft px-4 pb-2">
        {rows.map((r) => (
          <li key={String(r.id)} className="py-1.5 text-xs text-ink-soft">
            <span className="text-ink-faint">{when(r.createdAt)} UTC</span> · {r.actorEmail ?? "someone"}{" "}
            {ACTIVITY[r.action] ?? r.action} {target(r)}
            {r.agencyGrantId && agencyOf.has(r.agencyGrantId) ? ` · ${agencyOf.get(r.agencyGrantId)}` : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Person({
  grant,
  person,
  mayDecide,
}: {
  grant: GrantSummary;
  person: GrantSummary["people"][number];
  mayDecide: boolean;
}) {
  const label = person.fullName ? `${person.fullName} (${person.email})` : person.email;
  const decide = (decision: string, text: string, cls: string) => (
    <form action={decideAgencyPersonAction}>
      <CsrfField />
      <input type="hidden" name="grantId" value={grant.id} />
      <input type="hidden" name="userId" value={person.userId} />
      <input type="hidden" name="decision" value={decision} />
      <button type="submit" className={cls}>
        {text}
      </button>
    </form>
  );
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="min-w-0 truncate text-sm text-ink">
        {label} <span className="text-xs text-ink-faint">· {person.status}</span>
      </span>
      {grant.status === "active" || grant.status === "requested" ? (
        <span className="flex flex-wrap gap-1.5">
          {person.status === "requested" && mayDecide ? decide("approved", "Approve", primary) : null}
          {person.status === "requested" ? decide("declined", "Decline", button) : null}
          {person.status === "approved" ? decide("blocked", "Block", danger) : null}
          {person.status === "blocked" && mayDecide ? decide("approved", "Unblock", button) : null}
        </span>
      ) : null}
    </li>
  );
}

export function AgencySection({
  grants,
  activity,
  mayDecide,
}: {
  grants: GrantSummary[];
  activity: AuditRow[];
  mayDecide: boolean;
}) {
  const agencyActivity = activity.filter((r) => r.action.startsWith("agency."));
  const waiting = grants.filter((g) => g.status === "requested");
  const live = grants.filter((g) => g.live);
  const closed = grants.filter((g) => !waiting.includes(g) && !live.includes(g)).slice(0, 10);

  return (
    <section id="agency" aria-labelledby="agency-title" className="mt-10">
      <h2 id="agency-title" className="text-lg font-semibold tracking-tight text-ink">
        Agency access
      </h2>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        Agencies that work on this business, the people from them you approved, and until when. Agency people never
        become members, never manage your people, and lose access the moment you block them, end the grant, or its date
        comes.
      </p>

      {grants.length === 0 ? (
        <p className="mt-4 text-sm text-ink-faint">No agency has asked for access.</p>
      ) : null}

      {waiting.map((g) => (
        <div key={g.id} className="mt-4 rounded-xl border border-warn/40 bg-surface p-4 shadow-card">
          <p className="text-sm font-semibold text-ink">
            {g.otherName} asks for {roleName(g.role)} access for {g.durationDays} days
          </p>
          <p className="mt-1 text-sm text-ink-soft">&ldquo;{g.reason}&rdquo; · asked {day(g.requestedAt)}</p>
          {g.people.length > 0 ? (
            <ul className="mt-2 divide-y divide-line-soft">
              {g.people.map((p) => (
                <Person key={p.userId} grant={g} person={p} mayDecide={mayDecide} />
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-ink-faint">They have not named anybody yet.</p>
          )}
          {mayDecide ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <form action={approveGrantAction} className="flex flex-wrap items-end gap-2">
                <CsrfField />
                <input type="hidden" name="grantId" value={g.id} />
                <label className="text-xs text-ink-soft">
                  Role
                  <select name="role" defaultValue={g.role}
                    className="ml-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink">
                    {AGENCY_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-ink-soft">
                  Days
                  <input name="days" type="number" min={1} max={g.durationDays} defaultValue={g.durationDays}
                    className="ml-1 w-20 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink" />
                </label>
                <button type="submit" className={primary}>
                  Approve
                </button>
              </form>
              <form action={declineGrantAction}>
                <CsrfField />
                <input type="hidden" name="grantId" value={g.id} />
                <button type="submit" className={button}>
                  Decline
                </button>
              </form>
            </div>
          ) : (
            <p className="mt-3 text-xs text-ink-faint">Waiting for an owner of this business to decide.</p>
          )}
        </div>
      ))}

      {live.map((g) => (
        <div key={g.id} className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-ink">
              {g.otherName} · {roleName(g.role)} · until {day(g.expiresAt!)}
            </p>
            <form action={revokeGrantAction}>
              <CsrfField />
              <input type="hidden" name="grantId" value={g.id} />
              <button type="submit" className={danger}>
                End access
              </button>
            </form>
          </div>
          <ul className="mt-2 divide-y divide-line-soft">
            {g.people.length === 0 ? <li className="py-1.5 text-xs text-ink-faint">Nobody named yet.</li> : null}
            {g.people.map((p) => (
              <Person key={p.userId} grant={g} person={p} mayDecide={mayDecide} />
            ))}
          </ul>
        </div>
      ))}

      {closed.length > 0 ? (
        <details className="mt-4 rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-ink-soft">Ended and declined</summary>
          <ul className="divide-y divide-line-soft px-4 pb-2">
            {closed.map((g) => (
              <li key={g.id} className="py-1.5 text-xs text-ink-soft">
                {g.otherName} · {roleName(g.role)} ·{" "}
                {g.status === "active" ? `ended ${day(g.expiresAt!)}` : g.status} · asked {day(g.requestedAt)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {agencyActivity.length > 0 ? <Activity rows={agencyActivity} grants={grants} /> : null}
    </section>
  );
}
