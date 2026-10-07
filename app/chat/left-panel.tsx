"use client";

import Link from "next/link";
import { exitClientAction, chooseClientAction } from "../staff/actions";
import { newConversationAction } from "./actions";
import { RepoPicker } from "./repo-picker";
import type { WorkspaceData } from "./types";

/**
 * Left: whose workspace this is, its repository, and its conversations.
 *
 * Opening a client here writes the same 30-minute, reason-stamped grant the
 * Clients page writes — the form posts to the very same action — so the audit
 * reads the same whichever screen it was opened from.
 */
export function LeftPanel({ data }: { data: WorkspaceData }) {
  const expires = data.grant ? new Date(data.grant.expiresAt) : null;

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <section aria-labelledby="ws-client">
        <h2 id="ws-client" className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Client
        </h2>
        <div className="mt-2 rounded-lg border border-line bg-surface p-3">
          <p className="text-sm font-semibold text-ink">
            {data.client.isHouse ? "No client — house workspace" : data.client.name}
          </p>
          {data.grant && expires ? (
            <p className="mt-1 text-xs text-ink-faint">
              Open until {expires.toISOString().slice(11, 16)} UTC — “{data.grant.reason}”
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-faint">
              No client’s records are available until you open one.
            </p>
          )}
          {!data.client.isHouse ? (
            <form action={exitClientAction} className="mt-2">
              <input type="hidden" name="returnTo" value="chat" />
              <button type="submit" className="text-xs font-medium text-ink-soft underline-offset-2 hover:underline">
                Leave this client
              </button>
            </form>
          ) : null}
        </div>

        <details className="mt-2 rounded-lg border border-line bg-surface" open={data.client.isHouse}>
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink-soft">
            {data.client.isHouse ? "Open a client" : "Switch client"}
          </summary>
          <form action={chooseClientAction} className="space-y-2 px-3 pb-3">
            <input type="hidden" name="returnTo" value="chat" />
            <label className="block text-xs text-ink-soft">
              Client
              <select
                name="organizationId"
                required
                className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                defaultValue=""
              >
                <option value="" disabled>
                  Choose…
                </option>
                {data.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-ink-soft">
              Reason (kept in the audit record)
              <input
                name="reason"
                required
                minLength={8}
                maxLength={200}
                placeholder="Why are you opening this client?"
                className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint"
              />
            </label>
            <button
              type="submit"
              className="w-full rounded-md bg-brand-surface px-3 py-1.5 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
            >
              Open for 30 minutes
            </button>
          </form>
        </details>
      </section>

      <section aria-labelledby="ws-repo">
        <h2 id="ws-repo" className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Repository
        </h2>
        <RepoPicker data={data} />
      </section>

      <section aria-labelledby="ws-history" className="min-h-0 flex-1">
        <div className="flex items-center justify-between">
          <h2 id="ws-history" className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Conversations
          </h2>
          <form action={newConversationAction}>
            <button
              type="submit"
              className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-soft hover:bg-sunk"
            >
              New
            </button>
          </form>
        </div>
        <ul className="mt-2 space-y-0.5">
          {data.conversations.length === 0 ? (
            <li className="text-xs text-ink-faint">None yet for this client.</li>
          ) : (
            data.conversations.map((c) => {
              const active = c.id === data.conversation?.id;
              return (
                <li key={c.id}>
                  <Link
                    href={`/chat?c=${c.id}`}
                    aria-current={active ? "page" : undefined}
                    className={`block truncate rounded-md px-2 py-1.5 text-sm ${
                      active ? "bg-brand-soft font-medium text-brand" : "text-ink-soft hover:bg-sunk"
                    }`}
                  >
                    <span className="mr-1.5 text-[10px] font-semibold uppercase text-ink-faint">{c.mode}</span>
                    {c.title}
                  </Link>
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}
