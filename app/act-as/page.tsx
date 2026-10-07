import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaffAccess } from "@/lib/auth/authorize";
import {
  actAsHistoryForActor,
  listActAsCandidates,
} from "@/lib/db/identity";
import { mayActAsStaff } from "@/lib/auth/act-as";
import {
  ACT_AS_GRANT_SECONDS,
  ACT_AS_STAFF_CAPABILITY,
  GRANT_REASON_MAX,
  GRANT_REASON_MIN,
} from "@/lib/auth/policy";
import { PortalShell } from "../portal-shell";
import { startActingAsAction, stopActingAsAction } from "./actions";
import { CsrfField } from "../_components/csrf-field";

export const metadata: Metadata = { title: "Act as" };

const ERRORS: Record<string, string> = {
  blocked:
    "That screen belongs to the account itself, and is not available while you are acting as somebody. Stop first.",
  not_staff: "Only a staff session can act as somebody else.",
  second_factor: "Pass your second step first.",
  chaining:
    "You are already acting as somebody. Stop first — you cannot become a second person from inside the first.",
  reason: `Give a reason of at least ${GRANT_REASON_MIN} characters. It goes in the record and cannot be added afterwards.`,
  unknown_target: "That account no longer exists.",
  service_account:
    "That is a service account. It cannot sign in, so there is no side of it to see.",
  self: "You are already yourself.",
  needs_capability: `That account is staff. Acting as staff needs the ${ACT_AS_STAFF_CAPABILITY} capability, granted in the internal organization.`,
};

/**
 * Start, stop, and see what has been done.
 *
 * One page for both states on purpose. It is where the guards send anybody who
 * reaches an account-security screen while acting as somebody, and that
 * redirect has to land somewhere reachable from INSIDE a grant — acting as a
 * client, /staff is not, because a client session is not staff.
 */
export default async function ActAsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const ctx = await requireStaffAccess("/act-as");

  // Only the real person's staff-ness opens this. While acting as a client the
  // session's effective scope is not staff, and this page must still be
  // reachable — it is the way back.
  if (!ctx.realIsStaff) redirect("/jobs");

  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;

  const [candidates, history, mayStaff] = await Promise.all([
    listActAsCandidates(),
    actAsHistoryForActor(ctx.realUserId, 20),
    mayActAsStaff(ctx.realUserId),
  ]);

  const minutes = Math.round(ACT_AS_GRANT_SECONDS / 60);

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Act as</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        See Flow from somebody else&rsquo;s side. It lasts {minutes} minutes,
        names them across every screen, and is recorded with the reason you
        give. While it is running you cannot change their address, enrol an
        authenticator or read their recovery codes — it lets you do their work,
        never own their account.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
        >
          {error}
        </p>
      ) : null}

      {params.done === "stopped" ? (
        <p className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-ink">
          You are yourself again.
        </p>
      ) : null}

      {ctx.actingAs ? (
        <section className="mt-6 rounded-xl border border-warn/40 bg-warn/10 p-4">
          <h2 className="text-sm font-semibold text-ink">
            You are currently {ctx.actingAs.fullName ?? ctx.actingAs.email}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {ctx.actingAs.email} — {ctx.actingAs.reason}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Until {ctx.actingAs.expiresAt.toISOString().slice(11, 16)} UTC.
            Renew by starting them again; anybody else has to wait until you
            stop.
          </p>
          <form action={stopActingAsAction} className="mt-3">
            <CsrfField />
            <button
              type="submit"
              className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold
                         text-brand-on-surface transition-colors duration-150
                         hover:bg-brand-surface-hover focus-visible:outline-2
                         focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Stop and be yourself
            </button>
          </form>
        </section>
      ) : null}

      <h2 className="mt-8 text-sm font-semibold text-ink">People</h2>
      {!mayStaff ? (
        <p className="mt-1 text-xs text-ink-faint">
          Staff accounts are listed but refused: acting as one needs the{" "}
          <code className="font-mono">{ACT_AS_STAFF_CAPABILITY}</code>{" "}
          capability, which this account does not hold.
        </p>
      ) : null}

      <ul className="mt-3 grid gap-3">
        {candidates
          .filter((person) => person.id !== ctx.realUserId)
          .map((person) => (
            <li
              key={person.id}
              className="rounded-xl border border-line bg-surface p-4 shadow-card"
            >
              <form
                action={startActingAsAction}
                className="flex flex-wrap items-center gap-3"
              >
                <CsrfField />
                <input type="hidden" name="targetUserId" value={person.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {person.fullName ?? person.email}
                    {person.isStaff ? (
                      <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-xs font-semibold text-warn">
                        staff
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">
                    {person.email}
                    {person.organizations ? ` — ${person.organizations}` : ""}
                  </span>
                </span>
                <input
                  name="reason"
                  required
                  minLength={GRANT_REASON_MIN}
                  maxLength={GRANT_REASON_MAX}
                  placeholder="Why are you becoming this person?"
                  aria-label={`Reason for acting as ${person.email}`}
                  className="min-w-0 flex-[2] rounded-lg border border-line bg-surface
                             px-3 py-2 text-sm text-ink placeholder:text-ink-faint
                             focus:border-brand focus:outline-2 focus:outline-brand/30"
                />
                <button
                  type="submit"
                  className="flex-none rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold
                             text-brand-on-surface transition-colors duration-150
                             hover:bg-brand-surface-hover focus-visible:outline-2
                             focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {ctx.actingAs?.userId === person.id ? "Renew" : "Become"}
                </button>
              </form>
            </li>
          ))}
      </ul>

      {/*
        The audit, read back to the person who wrote it. Not the whole table —
        only this account's own grants — because it is here to make the record
        visible to the person it is a record of, not to be a search tool.
      */}
      <h2 className="mt-8 text-sm font-semibold text-ink">
        What you have done
      </h2>
      {history.length === 0 ? (
        <p className="mt-1 text-sm text-ink-faint">Nothing yet.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {history.map((row) => (
            <li
              key={row.id}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
            >
              <span className="font-medium text-ink">{row.targetEmail}</span>
              <span className="text-ink-faint">
                {" "}
                — {row.reason} — {row.startedAt.toISOString().slice(0, 16)}Z,{" "}
                {row.endedAt
                  ? `stopped ${row.endedAt.toISOString().slice(11, 16)}Z`
                  : row.isLive
                    ? "running"
                    : "lapsed"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  );
}
