import type { Metadata } from "next";
import { assignedPerPerson, jobsPerPerson } from "@/lib/db";
import { requirePage } from "@/lib/auth/authorize";
import {
  canAssignRole,
  canManageMember,
  isRoleTemplate,
  ROLE_LABELS,
  ROLE_TEMPLATES,
  allows,
} from "@/lib/auth/permissions";
import { organizationById, teamFor } from "@/lib/db/identity";
import { listInvitations } from "@/lib/db/invitations";
import { grantsForBusiness } from "@/lib/db/agency";
import { auditFor } from "@/lib/db/audit";
import { AGENCY_ERRORS, AGENCY_NOTICES, AgencySection } from "./agency-section";
import { PortalShell } from "../portal-shell";
import { CsrfField } from "../_components/csrf-field";
import {
  changeRoleAction,
  inviteAction,
  removeMemberAction,
  revokeInvitationAction,
} from "./actions";

export const metadata: Metadata = { title: "Team" };

/**
 * Who is on your side of the exchange, and what each of them has moved.
 *
 * Which team you see follows the same rule as everything else: the people of
 * the business the session is on. The business comes from the session, never
 * from the URL.
 */
const ERRORS: Record<string, string> = {
  email: "That does not look like an email address.",
  owner_only: "Only an owner can invite an owner, or change or remove one.",
  last_owner: "A company always keeps at least one owner. Make somebody else an owner first.",
  no_member: "That person is no longer on this team.",
  moved: "Their role changed while you were looking, so nothing was done. Here is the team as it is now.",
  unknown: "That invitation no longer exists.",
  mail: "The invitation was created, but the email did not send. Tell them to go to the sign-up screen with this address.",
};

const DONE: Record<string, string> = {
  invited: "Invitation sent. It lapses in 7 days if unused, and works once.",
  revoked: "Invitation withdrawn.",
  changed: "Role changed. It applies from their next click.",
  removed: "Removed. They lose access to this company from their next click.",
};

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string; agency?: string; agency_error?: string }>;
}) {
  const { ctx, businessId, role, via } = await requirePage("business.view", {
    returnPath: "/team",
  });
  const params = await searchParams;

  const teamOrgId = businessId;
  const teamOrg = await organizationById(businessId);

  // Only a role carrying staff.manage may invite — owners and managers — and
  // only they see who has been invited: an invitation names an address and a
  // role before the person has agreed to anything.
  // Through an agency grant nobody manages people, whatever the role
  // (AGENCY_NEVER): inviting would turn borrowed access into memberships.
  const mayInvite = allows(role, "staff.manage", via);
  const assignable = mayInvite ? ROLE_TEMPLATES.filter((template) => canAssignRole(role, template)) : [];
  const manages = (memberRole: string) => mayInvite && canManageMember(role, memberRole);

  const [members, raised, assigned, pending] = await Promise.all([
    teamOrgId ? teamFor(teamOrgId) : Promise.resolve([]),
    jobsPerPerson(ctx.scope),
    assignedPerPerson(ctx.scope),
    mayInvite ? listInvitations(ctx.scope) : Promise.resolve([]),
  ]);
  // Agency access: owners and managers see it (never through a grant); only
  // owners decide on it (grants.approve).
  const [agencyGrants, agencyActivity] = mayInvite
    ? await Promise.all([grantsForBusiness(businessId), auditFor(businessId, 30)])
    : [[], []];
  const mayDecideAgency = allows(role, "grants.approve", via);

  const raisedBy = new Map(raised.map((r) => [r.userId, r]));
  const assignedTo = new Map(assigned.map((r) => [r.userId, r.assigned]));

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={null}
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

      {params.agency && AGENCY_NOTICES[params.agency] ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          {AGENCY_NOTICES[params.agency]}
        </p>
      ) : null}
      {params.agency_error ? (
        <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {AGENCY_ERRORS[params.agency_error] ?? "That did not work."}
        </p>
      ) : null}
      {params.done ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good"
        >
          {DONE[params.done] ?? "Done."}
        </p>
      ) : null}

      {params.error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
        >
          {ERRORS[params.error] ?? "That did not work."}
        </p>
      ) : null}

      {mayInvite ? (
        <form
          action={inviteAction}
          className="mt-6 flex flex-wrap items-end gap-3 rounded-xl border
                     border-line bg-surface p-4 shadow-card"
        >
          <CsrfField />
          <div className="min-w-0 flex-1">
            <label
              htmlFor="invite-email"
              className="mb-1 block text-xs font-medium text-ink-soft"
            >
              Invite someone to {teamOrg?.name ?? "this company"}
            </label>
            <input
              id="invite-email"
              name="email"
              type="email"
              required
              maxLength={320}
              placeholder="them@company.com"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2
                         text-sm text-ink placeholder:text-ink-faint
                         focus:border-brand focus:outline-2 focus:outline-brand/30"
            />
          </div>
          <div>
            <label
              htmlFor="invite-role"
              className="mb-1 block text-xs font-medium text-ink-soft"
            >
              Role
            </label>
            <select
              id="invite-role"
              name="role"
              defaultValue="viewer"
              aria-describedby="invite-role-hint"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink
                         focus:border-brand focus:outline-2 focus:outline-brand/30"
            >
              {assignable.map((template) => (
                <option key={template} value={template}>
                  {ROLE_LABELS[template]}
                </option>
              ))}
            </select>
            <p id="invite-role-hint" className="mt-1 text-xs text-ink-faint">
              {role === "owner"
                ? "Owners and managers can invite; only an owner can invite an owner."
                : "Only an owner can invite an owner."}
            </p>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface
                       transition-colors duration-150 hover:bg-brand-surface-hover
                       focus-visible:outline-2 focus-visible:outline-offset-2
                       focus-visible:outline-brand"
          >
            Send invitation
          </button>
        </form>
      ) : null}

      {pending.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <p className="border-b border-line-soft bg-sunk px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Invited, not yet set up
          </p>
          <ul className="divide-y divide-line-soft">
            {pending.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{invitation.email}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-faint">
                    {invitation.organizationName} · {invitation.role} · lapses{" "}
                    {new Date(invitation.expiresAt).toISOString().slice(0, 10)}
                  </p>
                </div>
                {manages(invitation.role) &&
                invitation.organizationId === ctx.scope.organizationId ? (
                  <form action={revokeInvitationAction} className="flex-none">
                    <CsrfField />
                    <input
                      type="hidden"
                      name="invitationId"
                      value={invitation.id}
                    />
                    <button
                      type="submit"
                      className="rounded-md border border-line px-2.5 py-1 text-xs
                                 font-medium text-ink-soft transition-colors hover:bg-sunk
                                 focus-visible:outline-2 focus-visible:outline-offset-2
                                 focus-visible:outline-brand"
                    >
                      Withdraw
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
                      {/*
                        A service account is a system, not a colleague, and it
                        is listed here on purpose: work it files is counted
                        against a named thing rather than appearing to come
                        from a person who never sent it.
                      */}
                      {person.isService ? (
                        <span className="ml-2 rounded-full bg-sunk px-2 py-0.5 text-[11px] font-medium text-ink-faint">
                          integration
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-faint">
                      {person.isService ? "key" : person.email} ·{" "}
                      {isRoleTemplate(person.role) ? ROLE_LABELS[person.role] : person.role}
                    </p>
                    {!person.isService && manages(person.role) ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <form action={changeRoleAction} className="flex items-center gap-1.5">
                          <CsrfField />
                          <input type="hidden" name="userId" value={person.userId} />
                          <label htmlFor={`role-${person.userId}`} className="sr-only">
                            Role for {person.fullName ?? person.email}
                          </label>
                          <select
                            id={`role-${person.userId}`}
                            name="role"
                            defaultValue={isRoleTemplate(person.role) ? person.role : "viewer"}
                            className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink
                                       focus:border-brand focus:outline-2 focus:outline-brand/30"
                          >
                            {assignable.map((template) => (
                              <option key={template} value={template}>
                                {ROLE_LABELS[template]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="rounded-md border border-line px-2.5 py-1 text-xs
                                       font-medium text-ink-soft transition-colors hover:bg-sunk
                                       focus-visible:outline-2 focus-visible:outline-offset-2
                                       focus-visible:outline-brand"
                          >
                            Change role
                          </button>
                        </form>
                        <form action={removeMemberAction}>
                          <CsrfField />
                          <input type="hidden" name="userId" value={person.userId} />
                          <button
                            type="submit"
                            className="rounded-md border border-line px-2.5 py-1 text-xs
                                       font-medium text-bad transition-colors hover:bg-bad/5
                                       focus-visible:outline-2 focus-visible:outline-offset-2
                                       focus-visible:outline-brand"
                          >
                            {person.userId === ctx.userId ? "Leave" : "Remove"}
                          </button>
                        </form>
                      </div>
                    ) : null}
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
      {mayInvite ? <AgencySection grants={agencyGrants} activity={agencyActivity} mayDecide={mayDecideAgency} /> : null}
    </PortalShell>
  );
}
