import type { Metadata } from "next";
import { assignedPerPerson, jobsPerPerson } from "@/lib/db";
import { requireSession } from "@/lib/auth/require";
import {
  internalOrganization,
  liveGrantForSession,
  organizationById,
  teamFor,
} from "@/lib/db/identity";
import { PortalShell } from "../portal-shell";

export const metadata: Metadata = { title: "Team" };

/**
 * Who is on your side of the exchange, and what each of them has moved.
 *
 * Which team you see follows the same rule as everything else: a client sees
 * their own colleagues, and staff see the internal team — or, while acting on a
 * client, that client's people. The organization id comes from the session,
 * never from the URL.
 */
export default async function TeamPage() {
  const ctx = await requireSession("/team");

  const grant = ctx.scope.isStaff
    ? await liveGrantForSession(ctx.sessionId)
    : null;
  const actingOrg = grant ? await organizationById(grant.organizationId) : null;

  // Staff with no client chosen look at their own team; everyone else looks at
  // the company their session is scoped to.
  const internal = ctx.scope.isStaff ? await internalOrganization() : null;
  const teamOrgId = ctx.scope.organizationId ?? internal?.id ?? null;
  const teamOrg = teamOrgId
    ? actingOrg ?? internal ?? (await organizationById(teamOrgId))
    : null;

  const [members, raised, assigned] = await Promise.all([
    teamOrgId ? teamFor(teamOrgId) : Promise.resolve([]),
    jobsPerPerson(ctx.scope),
    assignedPerPerson(ctx.scope),
  ]);

  const raisedBy = new Map(raised.map((r) => [r.userId, r]));
  const assignedTo = new Map(assigned.map((r) => [r.userId, r.assigned]));

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={
        actingOrg && grant ? { name: actingOrg.name, reason: grant.reason } : null
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Team</h1>
      <p className="mt-1 text-sm text-ink-soft">
        {teamOrg ? (
          <>
            People at <strong className="text-ink">{teamOrg.name}</strong>, and the
            work each of them has sent and received.
          </>
        ) : (
          "Choose a client to see their people."
        )}
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        <div className="hidden grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,0.6fr))_minmax(0,0.9fr)] gap-4 border-b border-line-soft bg-sunk px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint sm:grid">
          <span>Person</span>
          <span className="text-right">Sent out</span>
          <span className="text-right">Received</span>
          <span className="text-right">Assigned</span>
          <span className="text-right">Last activity</span>
        </div>

        <ul className="divide-y divide-line-soft">
          {members.length === 0 ? (
            <li className="px-5 py-10 text-center text-sm text-ink-faint">
              Nobody here yet.
            </li>
          ) : (
            members.map((person) => {
              const stats = raisedBy.get(person.userId);
              const last = stats?.lastActivity
                ? new Date(stats.lastActivity)
                : null;
              return (
                <li
                  key={person.userId}
                  className="grid grid-cols-2 gap-x-4 gap-y-1 px-5 py-3
                             sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,0.6fr))_minmax(0,0.9fr)]"
                >
                  <div className="col-span-2 min-w-0 sm:col-span-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {person.fullName ?? person.email}
                      {person.userId === ctx.userId ? (
                        <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
                          you
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-faint">
                      {person.email} · {person.role}
                    </p>
                  </div>

                  <span className="text-right text-sm tabular-nums text-ink">
                    <span className="mr-2 text-xs text-ink-faint sm:hidden">
                      Sent
                    </span>
                    {stats?.sent ?? 0}
                  </span>
                  <span className="text-right text-sm tabular-nums text-ink">
                    <span className="mr-2 text-xs text-ink-faint sm:hidden">
                      Received
                    </span>
                    {stats?.received ?? 0}
                  </span>
                  <span className="text-right text-sm tabular-nums text-ink">
                    <span className="mr-2 text-xs text-ink-faint sm:hidden">
                      Assigned
                    </span>
                    {assignedTo.get(person.userId) ?? 0}
                  </span>
                  <span className="text-right text-xs tabular-nums text-ink-faint">
                    {last ? last.toISOString().slice(0, 10) : "—"}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </div>

      <p className="mt-3 max-w-prose text-xs text-ink-faint">
        Sent out and received count jobs a person raised, by direction. Assigned
        counts jobs currently pointed at them. All three are scoped to the
        company this session is acting on.
      </p>
    </PortalShell>
  );
}
