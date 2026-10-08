"use client";

import Link from "next/link";
import { newConversationAction } from "./actions";
import { CsrfInput } from "./csrf";
import { RepoPicker } from "./repo-picker";
import type { WorkspaceData } from "./types";

/**
 * Left: whose workspace this is, its repository, and its conversations.
 *
 * The business is the one the session has open. Chat Boss never opens a
 * business you do not belong to; to work on another of yours, switch to it
 * with the business switcher.
 */
export function LeftPanel({ data }: { data: WorkspaceData }) {
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <section aria-labelledby="ws-client">
        <h2 id="ws-client" className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Business
        </h2>
        <div className="mt-2 rounded-lg border border-line bg-surface p-3">
          <p className="text-sm font-semibold text-ink">{data.client.name}</p>
          <p className="mt-1 text-xs text-ink-faint">Chat Boss sees this business&rsquo;s records and nothing else.</p>
          {data.clients.length > 1 ? (
            <Link href="/business" className="mt-2 inline-block text-xs font-medium text-ink-soft underline-offset-2 hover:underline">
              Switch business
            </Link>
          ) : null}
        </div>
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
            <CsrfInput />
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
