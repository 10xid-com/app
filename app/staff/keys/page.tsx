import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/require";
import { listKeys } from "@/lib/db/api-keys";
import { liveGrantForSession, organizationById } from "@/lib/db/identity";
import { PortalShell } from "../../portal-shell";
import { mintKeyAction, revokeKeyAction } from "./actions";

export const metadata: Metadata = { title: "Keys" };

const ERRORS: Record<string, string> = {
  label: "Give the key a name of at least three characters, so it can be told apart later.",
  unknown: "That key no longer exists.",
};

/**
 * The keys a client's own systems use to file work.
 *
 * This is the Phase 3 rule arriving early, and it is the reason it was worth
 * arriving early: the moment a client's website needs to send something in, the
 * tempting shortcut is to let it post as a person. One leaked credential is
 * then both a human's whole account and every script that borrowed it. A key
 * cannot read anything, belongs to one company, and is revoked on its own.
 */
export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<{ minted?: string; revoked?: string; error?: string }>;
}) {
  const ctx = await requireSession("/staff/keys");
  if (!ctx.scope.isStaff) redirect("/jobs");

  const params = await searchParams;
  const grant = await liveGrantForSession(ctx.sessionId);
  const actingOrg = grant ? await organizationById(grant.organizationId) : null;
  const keys = await listKeys(ctx.scope);

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
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Integration keys
      </h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        A key lets one client&rsquo;s own systems file work into the portal with
        nobody signed in — an estimate form on their website, for instance. A key
        can put work in and cannot take anything out.
      </p>

      {params.minted ? (
        <div className="mt-6 rounded-xl border border-good/40 bg-good/5 p-5">
          <p className="text-sm font-semibold text-ink">
            Copy this now. It will not be shown again.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-sunk px-3 py-2.5 font-mono text-xs text-ink">
            {params.minted}
          </pre>
          <p className="mt-3 max-w-prose text-xs text-ink-faint">
            Only its hash is stored, so nobody — including us — can read it back.
            It is in this page&rsquo;s address, and therefore in your browser
            history: if it does not go straight into the receiving system&rsquo;s
            settings, revoke it and mint another.
          </p>
        </div>
      ) : null}

      {params.revoked ? (
        <p className="mt-6 rounded-lg border border-line bg-sunk px-3 py-2 text-sm text-ink-soft">
          Key revoked. Work it already filed stays where it is.
        </p>
      ) : null}

      {params.error ? (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
        >
          {ERRORS[params.error] ?? "That did not work."}
        </p>
      ) : null}

      {actingOrg ? (
        <form
          action={mintKeyAction}
          className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border
                     border-line bg-surface p-4 shadow-card"
        >
          <label htmlFor="label" className="text-sm text-ink-soft">
            New key for <strong className="text-ink">{actingOrg.name}</strong>
          </label>
          <input
            id="label"
            name="label"
            required
            minLength={3}
            maxLength={80}
            placeholder="What will use it? e.g. Northstar website — estimate form"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2
                       text-sm text-ink placeholder:text-ink-faint
                       focus:border-brand focus:outline-2 focus:outline-brand/30"
          />
          <button
            type="submit"
            className="flex-none rounded-lg bg-brand px-4 py-2 text-sm font-semibold
                       text-white transition-colors duration-150 hover:bg-brand-dark
                       focus-visible:outline-2 focus-visible:outline-offset-2
                       focus-visible:outline-brand"
          >
            Mint key
          </button>
        </form>
      ) : (
        <p className="mt-6 rounded-xl border border-line bg-sunk px-4 py-3 text-sm text-ink-soft">
          You are looking at every client. Minting a key writes into one
          company&rsquo;s data, so{" "}
          <a href="/staff" className="text-brand underline underline-offset-2">
            choose a client
          </a>{" "}
          first — the reason you give is what the audit record shows.
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_repeat(3,minmax(0,0.8fr))] gap-4 border-b border-line-soft bg-sunk px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint sm:grid">
          <span>Key</span>
          <span>Company</span>
          <span className="text-right">Jobs filed</span>
          <span className="text-right">Last used</span>
          <span className="text-right">Status</span>
        </div>

        <ul className="divide-y divide-line-soft">
          {keys.length === 0 ? (
            <li className="px-5 py-10 text-center text-sm text-ink-faint">
              No keys yet.
            </li>
          ) : (
            keys.map((key) => (
              <li
                key={key.id}
                className="grid grid-cols-2 gap-x-4 gap-y-1 px-5 py-3
                           sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_repeat(3,minmax(0,0.8fr))]"
              >
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {key.label}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">
                    {key.prefix}
                    <span aria-label="hidden remainder">…</span>
                  </p>
                </div>
                <span className="truncate text-sm text-ink-soft">
                  {key.organizationName}
                </span>
                <span className="text-right text-sm tabular-nums text-ink">
                  {key.jobsFiled}
                </span>
                <span className="text-right text-xs tabular-nums text-ink-faint">
                  {key.lastUsedAt
                    ? new Date(key.lastUsedAt).toISOString().slice(0, 10)
                    : "never"}
                </span>
                <span className="text-right">
                  {key.revokedAt ? (
                    <span className="text-xs text-ink-faint">revoked</span>
                  ) : actingOrg && actingOrg.id === key.organizationId ? (
                    <form action={revokeKeyAction}>
                      <input type="hidden" name="keyId" value={key.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-line px-2.5 py-1 text-xs
                                   font-medium text-bad transition-colors hover:bg-bad/5
                                   focus-visible:outline-2 focus-visible:outline-offset-2
                                   focus-visible:outline-bad"
                      >
                        Revoke
                      </button>
                    </form>
                  ) : (
                    <span className="text-xs text-good">live</span>
                  )}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>

      <p className="mt-3 max-w-prose text-xs text-ink-faint">
        Keys are sent as <code className="font-mono">Authorization: Bearer …</code>{" "}
        to <code className="font-mono">/api/v1/jobs</code>, from the sending
        system&rsquo;s own server. Never from a web page: a key in browser
        JavaScript is a key published to everyone who loads the page.
      </p>
    </PortalShell>
  );
}
