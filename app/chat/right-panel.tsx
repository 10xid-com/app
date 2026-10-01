"use client";

import { useState } from "react";
import type { WireReceipt } from "@/lib/workspace/wire";
import { addJobContextAction, removeContextAction } from "./actions";
import type { UiRun, WorkspaceData } from "./types";

/**
 * Right: what the model actually saw.
 *
 * Everything here is read from receipts — rows written while the run happened
 * — not reconstructed from the answer's text. "Sent to provider" separates
 * what the application looked at from what left for the provider named on the
 * run.
 */

const TABS = [
  { id: "sources", label: "Sources" },
  { id: "context", label: "Context" },
  { id: "activity", label: "Activity" },
  { id: "changes", label: "Changes" },
  { id: "attachments", label: "Attachments" },
  { id: "repository", label: "Repository" },
  { id: "receipts", label: "Receipts" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function RightPanel({ data, run }: { data: WorkspaceData; run: UiRun | null }) {
  const [tab, setTab] = useState<TabId>("sources");

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="Context and activity" className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-none rounded-md px-2 py-1 text-xs font-medium ${
              tab === t.id ? "bg-brand-soft text-brand" : "text-ink-soft hover:bg-sunk"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {tab === "sources" ? <Sources run={run} /> : null}
        {tab === "context" ? <Context data={data} /> : null}
        {tab === "activity" ? <Activity run={run} /> : null}
        {tab === "changes" ? (
          <Empty text="Ask and Plan never change anything, so there are no proposed changes. Build mode — patches on an isolated branch, with approval and rollback — is not switched on." />
        ) : null}
        {tab === "attachments" ? (
          <Empty text="Image and document attachments arrive in a later update: stored privately, scanned, and only ever shown to this client's workspace." />
        ) : null}
        {tab === "repository" ? (
          <Empty text="No repository is connected. The next update adds read-only GitHub access for this client's repositories." />
        ) : null}
        {tab === "receipts" ? <Receipts run={run} client={data.client.name} isHouse={data.client.isHouse} /> : null}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-xs leading-relaxed text-ink-faint">{text}</p>;
}

function NoRun() {
  return <Empty text="Select an answer to see what it was based on." />;
}

function ReceiptList({ items }: { items: WireReceipt[] }) {
  if (items.length === 0) return <Empty text="None." />;
  return (
    <ul className="space-y-1.5">
      {items.map((r, i) => (
        <li key={i} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
          <p className="break-words text-[13px] text-ink">{r.label}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {r.kind.replace("_", " ")} · {r.sentToProvider ? "sent to the provider" : "not sent to the provider"}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Sources({ run }: { run: UiRun | null }) {
  if (!run) return <NoRun />;
  const sources = run.receipts.filter((r) => r.kind === "job" || r.kind === "file" || r.kind === "folder" || r.kind === "attachment");
  return (
    <>
      <h3 className="mb-2 text-xs font-semibold text-ink-soft">Business records and files this answer used</h3>
      <ReceiptList items={sources} />
    </>
  );
}

function Activity({ run }: { run: UiRun | null }) {
  if (!run) return <NoRun />;
  return (
    <>
      <h3 className="mb-2 text-xs font-semibold text-ink-soft">Tools run and warnings</h3>
      <ReceiptList items={run.receipts.filter((r) => r.kind === "tool_call" || r.kind === "warning")} />
    </>
  );
}

function Receipts({ run, client, isHouse }: { run: UiRun | null; client: string; isHouse: boolean }) {
  if (!run) return <NoRun />;
  const count = (kinds: string[]) => run.receipts.filter((r) => kinds.includes(r.kind)).length;
  const rows: [string, string][] = [
    ["Engine", run.engineLabel],
    ["Model", run.model],
    ["Provider", run.provider],
    ["Mode", run.mode === "plan" ? "Plan — no changes" : "Ask — no changes"],
    ["Client scope", isHouse ? "House (no client)" : client],
    ["Repository / branch", "None connected"],
    ["Files inspected", String(count(["file", "folder"]))],
    ["Business records", String(count(["job"]))],
    ["Tools executed", String(count(["tool_call"]))],
    ["Warnings and failures", String(count(["warning"]) + (run.error ? 1 : 0))],
    ["Outcome", run.status + (run.error ? ` — ${run.error}` : "")],
    ["Tokens", run.inputTokens === null ? "—" : `${run.inputTokens} in, ${run.outputTokens ?? 0} out`],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-faint">{k}</dt>
          <dd className="break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Context({ data }: { data: WorkspaceData }) {
  if (!data.conversation) return <Empty text="Start a conversation to add context." />;
  return (
    <>
      <h3 className="mb-2 text-xs font-semibold text-ink-soft">Included in every answer in this conversation</h3>
      {data.context.length === 0 ? (
        <Empty text="Nothing selected. The model can still look up this client's jobs itself." />
      ) : (
        <ul className="space-y-1.5">
          {data.context.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-2 rounded-md border border-brand/30 bg-brand-soft/40 px-2.5 py-1.5">
              <span className="break-words text-[13px] text-ink">{c.label}</span>
              <form action={removeContextAction}>
                <input type="hidden" name="conversationId" value={data.conversation!.id} />
                <input type="hidden" name="itemId" value={c.id} />
                <button type="submit" className="text-xs text-ink-faint hover:text-bad" aria-label={`Remove ${c.label}`}>
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {data.client.isHouse ? (
        <p className="mt-3 text-xs text-ink-faint">Open a client to add its jobs.</p>
      ) : (
        <form action={addJobContextAction} className="mt-3 flex gap-2">
          <input type="hidden" name="conversationId" value={data.conversation.id} />
          <label className="sr-only" htmlFor="ctx-job">
            Job reference
          </label>
          <input
            id="ctx-job"
            name="ref"
            required
            placeholder="Job reference, e.g. ROT-0042"
            pattern="[A-Za-z0-9]{2,8}-\d{1,6}"
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm placeholder:text-ink-faint"
          />
          <button type="submit" className="rounded-md border border-line px-2.5 text-xs font-medium text-ink-soft hover:bg-sunk">
            Add
          </button>
        </form>
      )}
    </>
  );
}
