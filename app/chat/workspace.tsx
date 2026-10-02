"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { COMMAND_SPECS, MODE_SPECS, parseCommand, type CommandId } from "@/lib/workspace/commands";
import { parseMentions } from "@/lib/workspace/mentions";
import type { WireEvent, WireReceipt } from "@/lib/workspace/wire";
import { newConversationAction, setEngineAction, setModeAction } from "./actions";
import { LeftPanel } from "./left-panel";
import { MessageText } from "./message-text";
import { RightPanel } from "./right-panel";
import type { UiRun, WorkspaceData } from "./types";

/**
 * The workspace: three panels on a wide screen; on a narrow one the side
 * panels become drawers and the conversation keeps the whole width.
 *
 * Saved state comes from the server (`data`) and is the truth. While an answer
 * streams, it is drawn from the events as they arrive; when it finishes, the
 * page data is refreshed and the saved version replaces the streamed one, so
 * what stays on screen is what was recorded.
 */

type Live = {
  userText: string;
  command: CommandId | null;
  run: Extract<WireEvent, { type: "run" }> | null;
  answer: string;
  activity: string[];
  receipts: WireReceipt[];
  notices: string[];
  finished: boolean;
};

export function Workspace({ data }: { data: WorkspaceData }) {
  const router = useRouter();
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
  const [streamed, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(data.error);
  const [draft, setDraft] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Text typed before the page finished loading is in the box but not in
  // state; adopt it once rather than wiping it on the first render.
  useEffect(() => {
    const early = input.current?.value;
    if (early) setDraft(early);
  }, []);

  // Once the refreshed, saved conversation has arrived, the streamed copy is
  // no longer shown: what stays on screen is what was recorded.
  const live = streamed && (!streamed.finished || refreshing) ? streamed : null;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [data.messages.length, live?.answer, live?.activity.length]);

  useEffect(() => () => abort.current?.abort(), []);

  const runsByUserMessage = useMemo(
    () => new Map(data.runs.map((r) => [r.userMessageId, r])),
    [data.runs],
  );
  const lastRun = data.runs.at(-1) ?? null;
  const selectedRun = data.runs.find((r) => r.id === selectedRunId) ?? lastRun;
  const engine = data.engines.find((e) => e.id === data.conversation?.engineMode);
  const busy = live !== null && !live.finished;

  async function send() {
    const text = draft.trim();
    if (!text || !data.conversation || busy) return;
    const { command, rest } = parseCommand(text);
    setDraft("");
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setLive({ userText: rest || text, command, run: null, answer: "", activity: [], receipts: [], notices: [], finished: false });

    try {
      const res = await fetch(`/api/workspace/conversations/${data.conversation.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `The request failed (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let refused: string | null = null;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line) as WireEvent;
          if (event.type === "error") refused = event.message;
          setLive((prev) => (prev ? apply(prev, event) : prev));
        }
        if (done) break;
      }
      if (refused) {
        // Nothing was sent or saved: put the words back so a retry is one press.
        setLive(null);
        setDraft(text);
        setError(refused);
        return;
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "The request failed.");
      }
    } finally {
      abort.current = null;
      setLive((prev) => (prev ? { ...prev, finished: true } : prev));
      startRefresh(() => router.refresh());
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  // "@" followed by part of a path: offer matching files from the repository.
  const repo = data.repository.current;
  const mentionQuery = repo ? (/(?:^|\s)@([A-Za-z0-9_.\-/]{2,})$/.exec(draft)?.[1] ?? null) : null;
  const [mentionHits, setMentionHits] = useState<{ query: string; paths: string[] } | null>(null);
  useEffect(() => {
    if (!mentionQuery || !data.conversation) return;
    const conversationId = data.conversation.id;
    const timer = setTimeout(async () => {
      const res = await fetch(
        `/api/workspace/conversations/${conversationId}/repository?view=search&mode=filename&q=${encodeURIComponent(mentionQuery)}`,
      ).catch(() => null);
      const body = res?.ok ? await res.json() : null;
      setMentionHits({ query: mentionQuery, paths: (body?.hits ?? []).slice(0, 8).map((h: { path: string }) => h.path) });
    }, 250);
    return () => clearTimeout(timer);
  }, [mentionQuery, data.conversation]);
  const mentionMenu = mentionQuery && mentionHits?.query === mentionQuery ? mentionHits.paths : null;
  const mentions = repo ? parseMentions(draft) : [];

  const typedCommand = parseCommand(draft).command;
  const showCommandMenu = /^\/\w*$/.test(draft.trim()) && !typedCommand;

  const center = (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header: mode, engine, drawer toggles. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => setDrawer("left")}
          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-soft lg:hidden"
        >
          Workspace
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {data.conversation?.title ?? "Workspace"}
        </h1>
        {data.conversation ? (
          <>
            <div role="group" aria-label="Mode" className="flex rounded-md border border-line p-0.5">
              {(["ask", "plan"] as const).map((m) => (
                <form key={m} action={setModeAction}>
                  <input type="hidden" name="conversationId" value={data.conversation!.id} />
                  <input type="hidden" name="mode" value={m} />
                  <button
                    type="submit"
                    disabled={busy}
                    aria-pressed={data.conversation!.mode === m}
                    title={MODE_SPECS[m].summary}
                    className={`rounded px-2.5 py-1 text-xs font-semibold ${
                      data.conversation!.mode === m ? "bg-brand-surface text-brand-on-surface" : "text-ink-soft hover:bg-sunk"
                    }`}
                  >
                    {MODE_SPECS[m].label}
                  </button>
                </form>
              ))}
              <button
                type="button"
                disabled
                title={MODE_SPECS.build.summary}
                className="cursor-not-allowed rounded px-2.5 py-1 text-xs font-semibold text-ink-faint line-through"
              >
                Build
              </button>
            </div>
            <form action={setEngineAction}>
              <input type="hidden" name="conversationId" value={data.conversation.id} />
              <label className="sr-only" htmlFor="ws-engine">
                Engine
              </label>
              <select
                id="ws-engine"
                name="engineMode"
                value={data.conversation.engineMode}
                disabled={busy}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
                className="max-w-[14rem] rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
              >
                {data.engines.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.available}>
                    {e.label}
                    {e.available ? "" : " — unavailable"}
                  </option>
                ))}
              </select>
            </form>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => setDrawer("right")}
          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-soft xl:hidden"
        >
          Context
        </button>
      </div>

      {data.conversation ? (
        <div className="border-b border-line bg-sunk/60 px-3 py-1.5 text-[11px] text-ink-soft">
          <strong className="font-semibold text-ink">{MODE_SPECS[data.conversation.mode].label} mode</strong> —{" "}
          {MODE_SPECS[data.conversation.mode].summary}{" "}
          {engine && !engine.available ? <span className="text-bad">{engine.label} is unavailable: {engine.reason}</span> : null}
          {engine && engine.available && !engine.canUseTools ? (
            <span className="text-warn">{engine.label} cannot read records; answers will not be grounded.</span>
          ) : null}
        </div>
      ) : null}

      {/* Conversation. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6" aria-live="polite">
        {!data.conversation ? (
          <div className="mx-auto max-w-md py-16 text-center">
            <p className="text-sm text-ink-soft">
              {data.client.isHouse
                ? "Open a client on the left to work with its records, or start a house conversation."
                : `Start a conversation about ${data.client.name}.`}
            </p>
            <form action={newConversationAction} className="mt-4">
              <button type="submit" className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface">
                New conversation
              </button>
            </form>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            {data.messages.length === 0 && !live ? (
              <p className="py-10 text-center text-sm text-ink-faint">
                Ask about this client’s jobs, or type <code className="font-mono">/</code> for commands.
              </p>
            ) : null}
            {data.messages.map((m) => {
              if (m.role === "user") {
                const run = runsByUserMessage.get(m.id);
                const answered = run && data.messages.some((x) => x.runId === run.id);
                return (
                  <div key={m.id} className="space-y-3">
                    <UserBubble text={m.content} command={m.command} />
                    {run && !answered ? (
                      <RunFailure run={run} onSelect={() => { setSelectedRunId(run.id); setDrawer("right"); }} />
                    ) : null}
                  </div>
                );
              }
              const run = data.runs.find((r) => r.id === m.runId) ?? null;
              return (
                <div key={m.id} className="space-y-1.5">
                  <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-ink shadow-card">
                    <MessageText text={m.content} />
                    {m.status !== "complete" ? (
                      <p className="mt-2 text-xs text-warn">{m.status === "cut_off" ? "Stopped before the end." : "This answer failed part-way."}</p>
                    ) : null}
                  </div>
                  {run ? (
                    <RunSummary
                      run={run}
                      client={data.client}
                      selected={selectedRun?.id === run.id}
                      onSelect={() => { setSelectedRunId(run.id); setDrawer("right"); }}
                    />
                  ) : null}
                </div>
              );
            })}

            {live ? (
              <div className="space-y-3">
                <UserBubble text={live.userText} command={live.command} />
                <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-ink shadow-card">
                  {live.activity.length ? (
                    <ul className="mb-2 space-y-0.5 text-xs text-ink-faint">
                      {live.activity.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  ) : null}
                  {live.answer ? <MessageText text={live.answer} /> : <span className="text-ink-faint">{live.run ? "Working…" : "Starting…"}</span>}
                  {live.notices.map((n, i) => (
                    <p key={i} className="mt-2 text-xs text-warn">{n}</p>
                  ))}
                </div>
                {live.run ? (
                  <p className="px-1 text-[11px] text-ink-faint">
                    {live.run.engineLabel} · {live.run.model} · {live.run.client.isHouse ? "house" : live.run.client.name} ·{" "}
                    {plural(live.receipts.filter((r) => r.kind === "job").length, "record")} so far
                  </p>
                ) : null}
              </div>
            ) : null}
            <div ref={end} />
          </div>
        )}
      </div>

      {/* Composer. */}
      {data.conversation ? (
        <div className="border-t border-line bg-ground px-3 pb-3 pt-2 sm:px-6">
          <div className="mx-auto max-w-3xl">
            {error ? (
              <p role="alert" className="mb-2 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
                {error}
              </p>
            ) : null}
            {showCommandMenu ? (
              <ul className="mb-2 overflow-hidden rounded-lg border border-line bg-surface shadow-card" aria-label="Commands">
                {(Object.keys(COMMAND_SPECS) as CommandId[])
                  .filter((id) => id.startsWith(draft.trim().slice(1).toLowerCase()))
                  .map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => setDraft(`/${id} `)}
                        className="flex w-full gap-2 px-3 py-1.5 text-left text-sm hover:bg-sunk"
                      >
                        <span className="font-mono font-semibold text-ink">{COMMAND_SPECS[id].label}</span>
                        <span className="text-ink-soft">{COMMAND_SPECS[id].summary}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
            {mentionMenu ? (
              <ul className="mb-2 overflow-hidden rounded-lg border border-line bg-surface shadow-card" aria-label="Files">
                {mentionMenu.length === 0 ? (
                  <li className="px-3 py-1.5 text-sm text-ink-faint">No file names match “{mentionQuery}”.</li>
                ) : (
                  mentionMenu.map((path) => (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft((d) => d.replace(/@[^\s@]*$/, `@${path} `));
                          input.current?.focus();
                        }}
                        className="block w-full truncate px-3 py-1.5 text-left font-mono text-[13px] text-ink hover:bg-sunk"
                      >
                        @{path}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
            {mentions.length && !mentionMenu ? (
              <p className="mb-1.5 truncate text-xs text-ink-soft">
                Adds to context: {mentions.map((m) => (m.kind === "folder" ? `${m.path || "/"} (folder)` : m.path)).join(", ")}
              </p>
            ) : null}
            {typedCommand ? (
              <p className="mb-1.5 text-xs text-ink-soft">
                <span className="font-mono font-semibold text-ink">{COMMAND_SPECS[typedCommand].label}</span> —{" "}
                {COMMAND_SPECS[typedCommand].summary}
              </p>
            ) : null}
            <div className="flex items-end gap-2">
              <button
                type="button"
                disabled
                title="Attachments arrive in a later update."
                className="flex-none cursor-not-allowed rounded-lg border border-line px-2.5 py-2 text-sm text-ink-faint"
                aria-label="Attach a file (not available yet)"
              >
                +
              </button>
              <label className="sr-only" htmlFor="ws-input">
                Message
              </label>
              <textarea
                id="ws-input"
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                maxLength={20000}
                placeholder={
                  repo
                    ? `Ask about this client or ${repo.name} — / for commands, @ for files. Enter sends.`
                    : "Ask about this client — / for commands. Enter sends, Shift+Enter for a new line."
                }
                className="min-w-0 flex-1 resize-y rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-2 focus:outline-brand/30"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => abort.current?.abort()}
                  className="flex-none rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-sunk"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!draft.trim() || !engine?.available}
                  className="flex-none rounded-xl bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-50"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 bg-ground">
      {/* Left: a column on large screens, a drawer below that. */}
      <aside
        aria-label="Workspace and conversations"
        className={`${drawer === "left" ? "fixed inset-y-0 left-0 z-40 w-80 max-w-[85vw] shadow-card-lg" : "hidden"} border-r border-line bg-ground lg:static lg:block lg:w-72 lg:flex-none lg:shadow-none`}
      >
        <DrawerClose show={drawer === "left"} onClose={() => setDrawer(null)} />
        <LeftPanel data={data} />
      </aside>

      <section className="min-w-0 flex-1">{center}</section>

      <aside
        aria-label="Context and activity"
        className={`${drawer === "right" ? "fixed inset-y-0 right-0 z-40 w-96 max-w-[90vw] shadow-card-lg" : "hidden"} border-l border-line bg-ground xl:static xl:block xl:w-96 xl:flex-none xl:shadow-none`}
      >
        <DrawerClose show={drawer === "right"} onClose={() => setDrawer(null)} />
        <RightPanel data={data} run={selectedRun} />
      </aside>

      {drawer ? (
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => setDrawer(null)}
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
        />
      ) : null}
    </div>
  );
}

function apply(prev: Live, event: WireEvent): Live {
  switch (event.type) {
    case "run":
      return { ...prev, run: event };
    case "text":
      return { ...prev, answer: prev.answer + event.text };
    case "tool":
      return event.phase === "start"
        ? { ...prev, activity: [...prev.activity, `Running ${event.name}…`] }
        : { ...prev, activity: [...prev.activity, `${event.name} ${event.ok ? "done" : "failed"}: ${event.summary ?? ""}`] };
    case "receipt":
      return { ...prev, receipts: [...prev.receipts, event.receipt] };
    case "notice":
      return { ...prev, notices: [...prev.notices, event.message] };
    case "model":
      return { ...prev, notices: [...prev.notices, `Answered by ${event.model}.`] };
    case "done":
      return { ...prev, finished: true };
    case "error":
      return prev;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function UserBubble({ text, command }: { text: string; command: string | null }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-surface px-4 py-2.5 text-sm text-brand-on-surface">
        {command ? <span className="mr-1.5 rounded bg-white/20 px-1 font-mono text-xs">/{command}</span> : null}
        <span className="whitespace-pre-wrap break-words">{text}</span>
      </div>
    </div>
  );
}

/** Under every answer: engine, model, client, and how much it looked at. */
function RunSummary({
  run,
  client,
  selected,
  onSelect,
}: {
  run: UiRun;
  client: WorkspaceData["client"];
  selected: boolean;
  onSelect: () => void;
}) {
  const n = (k: string) => run.receipts.filter((r) => r.kind === k).length;
  const warnings = n("warning");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`px-1 text-left text-[11px] ${selected ? "text-brand" : "text-ink-faint"} hover:underline`}
    >
      {run.engineLabel} · {run.model} · {client.isHouse ? "house" : client.name} ·{" "}
      {run.repository ? `${run.repository.name}@${run.repository.branch} · ${plural(n("file"), "file")}` : "no repository"} ·{" "}
      {plural(n("job"), "record")} · {plural(n("tool_call"), "tool")}
      {warnings ? ` · ${plural(warnings, "warning")}` : ""} — see what it used
    </button>
  );
}

function RunFailure({ run, onSelect }: { run: UiRun; onSelect: () => void }) {
  return (
    <div className="rounded-xl border border-bad/30 bg-bad/5 px-4 py-3 text-sm text-bad">
      {run.status === "cancelled" ? "Stopped before any answer arrived." : (run.error ?? "This answer failed.")}{" "}
      <button type="button" onClick={onSelect} className="text-xs underline">
        Details
      </button>
    </div>
  );
}

function DrawerClose({ show, onClose }: { show: boolean; onClose: () => void }) {
  if (!show) return null;
  return (
    <div className="flex justify-end border-b border-line p-2 lg:hidden">
      <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-sunk">
        Close
      </button>
    </div>
  );
}
