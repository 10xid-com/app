import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/require";
import {
  listClientOrganizations,
  liveGrantForSession,
  organizationById,
} from "@/lib/db/identity";
import { PortalShell } from "../portal-shell";
import { chooseClientAction } from "./actions";

export const metadata: Metadata = { title: "Clients" };

const ERRORS: Record<string, string> = {
  reason: "Give a reason of at least eight characters. It goes in the audit record.",
  unknown: "That client no longer exists.",
};

/**
 * The client picker.
 *
 * Staff do not land on a dashboard with the keys to everything. They land here
 * and choose one client, giving a reason, which writes a time-boxed grant. The
 * reason is not bureaucracy: it is the difference between an audit trail that
 * says "an admin was active at 14:02" and one that says "Paolo opened Rotary at
 * 14:02 because a client emailed about a proof" — the second is the unit of
 * disclosure you would need if a client ever asked what was accessed.
 */
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await requireSession("/staff");
  if (!ctx.scope.isStaff) redirect("/jobs");

  const params = await searchParams;
  const clients = await listClientOrganizations();

  const grant = await liveGrantForSession(ctx.sessionId);
  const actingOrg = grant ? await organizationById(grant.organizationId) : null;

  return (
    <PortalShell
      email={ctx.email}
      isStaff
      actingOn={
        actingOrg && grant
          ? { name: actingOrg.name, reason: grant.reason }
          : null
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Clients</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        Choose a client to act on. Access lasts 30 minutes, covers that one
        client, and is recorded with the reason you give.
      </p>

      {params.error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
        >
          {ERRORS[params.error] ?? "That did not work."}
        </p>
      ) : null}

      <ul className="mt-6 grid gap-3">
        {clients.map((client) => (
          <li
            key={client.id}
            className="rounded-xl border border-line bg-surface p-4 shadow-card"
          >
            <form
              action={chooseClientAction}
              className="flex flex-wrap items-center gap-3"
            >
              <input type="hidden" name="organizationId" value={client.id} />
              <span
                aria-hidden
                className="h-8 w-8 flex-none rounded-lg"
                style={{ background: client.brandPrimaryHex ?? "#26467F" }}
              />
              <span className="min-w-0 flex-1 text-sm font-medium text-ink">
                {client.name}
              </span>
              <input
                name="reason"
                required
                minLength={8}
                maxLength={200}
                placeholder="Why are you opening this client?"
                aria-label={`Reason for opening ${client.name}`}
                className="min-w-0 flex-[2] rounded-lg border border-line bg-surface
                           px-3 py-2 text-sm text-ink placeholder:text-ink-faint
                           focus:border-brand focus:outline-2 focus:outline-brand/30"
              />
              <button
                type="submit"
                className="flex-none rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold
                           text-brand-on-surface transition-colors duration-150 hover:bg-brand-surface-hover
                           focus-visible:outline-2 focus-visible:outline-offset-2
                           focus-visible:outline-brand"
              >
                Open
              </button>
            </form>
          </li>
        ))}
      </ul>
    </PortalShell>
  );
}
