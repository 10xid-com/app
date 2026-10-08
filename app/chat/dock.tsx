"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { CSRF_HEADER } from "@/lib/auth/csrf-names";
import type { WireEvent } from "@/lib/workspace/wire";
import { Icon } from "../_components/icons";
import { useChatPanel } from "../portal-nav";
import { newDockConversationAction } from "./actions";
import { CsrfInput, CsrfProvider } from "./csrf";
import { MessageText } from "./message-text";
import { BlogDraftCard } from "./blog-draft-card";
import type { BlogDraftView } from "@/lib/workspace/blog-draft";

/**
 * Chat Boss on every page: the right-hand column of the frame.
 *
 * It is the same Chat Boss as /chat — the same conversations, the same
 * streaming endpoint, the same checks — reduced to one conversation and a
 * composer, so it fits beside whatever page is open. The workspace keeps
 * everything that needs room: switching conversations, the mode and engine,
 * repositories, and the receipts for what every answer saw. "Open workspace"
 * goes there, on this conversation.
 *
 * Who may use it is unchanged: the people on the Chat Boss list, on a business
 * they belong to (lib/auth/chat-boss.ts). Everybody else sees the panel and is
 * told it is not switched on for them; nothing in it reaches the endpoint.
 */

export type ChatDockData =
  | { state: "off" }
  | {
      state: "on";
      csrf: string;
      businessName: string;
      conversation: {
        id: string;
        title: string;
        engine: { label: string; available: boolean; reason: string | null } | null;
      } | null;
      /** The most recent messages, oldest first. */
      messages: { id: string; role: "user" | "assistant"; content: string; status: string; drafts: BlogDraftView[] }[];
      /** How many earlier messages are only in the workspace. */
      earlier: number;
    };

type Live = { userText: string; answer: string; activity: string | null; finished: boolean };

export function ChatDock({ data }: { data: ChatDockData }) {
  const { close } = useChatPanel();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 flex-none items-center gap-2 border-b border-line-soft px-3">
        <button
          type="button"
          onClick={close}
          aria-label="Hide Chat Boss"
          className="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink-soft transition-colors
                     hover:bg-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Icon name="sidebar-right" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-[650] text-ink">Chat Boss</h2>
          {data.state === "on" && data.conversation ? (
            <p className="truncate text-[12px] text-ink-faint">{data.conversation.title}</p>
          ) : null}
        </div>
        {data.state === "on" && data.conversation ? (
          <Link
            href={`/chat?c=${data.conversation.id}`}
            className="flex-none rounded-md px-2 py-1 text-[12.5px] font-[560] text-ink-soft transition-colors
                       hover:bg-sunk hover:text-ink"
          >
            Open workspace
          </Link>
        ) : null}
      </div>

      {data.state === "on" ? (
        <CsrfProvider value={data.csrf}>
          <Conversation data={data} />
        </CsrfProvider>
      ) : (
        <Off />
      )}
    </div>
  );
}

function Off() {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-sunk text-ink-soft">
          <Icon name="chat" />
        </span>
        <p className="mt-3 text-[15px] font-[600] text-ink">Chat Boss isn’t on for you yet</p>
        <p className="mt-1 max-w-[18rem] text-sm text-ink-soft">
          It works on your business’s jobs and records with you. Ask your 10XiD contact to switch it on.
        </p>
      </div>
      <Composer disabled draft="" setDraft={() => {}} onSend={() => {}} busy={false} onStop={() => {}} workspaceHref={null} />
    </>
  );
}

function Conversation({ data }: { data: Extract<ChatDockData, { state: "on" }> }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [streamed, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [starting, startNew] = useTransition();
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // Once the refreshed, saved conversation has arrived, the streamed copy is
  // no longer shown: what stays on screen is what was recorded.
  const live = streamed && (!streamed.finished || refreshing) ? streamed : null;
  const busy = live !== null && !live.finished;
  const conversation = data.conversation;
  const engine = conversation?.engine ?? null;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [data.messages.length, live?.answer]);

  useEffect(() => () => abort.current?.abort(), []);

  async function send() {
    const text = draft.trim();
    if (!text || !conversation || busy) return;
    setDraft("");
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setLive({ userText: text, answer: "", activity: null, finished: false });

    try {
      const res = await fetch(`/api/workspace/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: data.csrf },
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
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      abort.current = null;
      setLive((prev) => (prev ? { ...prev, finished: true } : prev));
      startRefresh(() => router.refresh());
    }
  }

  if (!conversation) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand">
          <Icon name="chat" />
        </span>
        <p className="mt-3 text-[15px] font-[600] text-ink">Work with Chat Boss</p>
        <p className="mt-1 max-w-[18rem] text-sm text-ink-soft">
          Ask about {data.businessName}’s jobs and records, or plan the next piece of work.
        </p>
        <form action={(form) => startNew(() => newDockConversationAction(form))} className="mt-4">
          <CsrfInput />
          <button
            type="submit"
            disabled={starting}
            className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface
                       hover:bg-brand-surface-hover disabled:opacity-60"
          >
            {starting ? "Starting…" : "Start a conversation"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-live="polite">
        <div className="space-y-4">
          {data.earlier ? (
            <Link
              href={`/chat?c=${conversation.id}`}
              className="block text-center text-xs text-ink-faint hover:text-ink hover:underline"
            >
              {data.earlier} earlier {data.earlier === 1 ? "message" : "messages"} in the workspace
            </Link>
          ) : null}
          {data.messages.length === 0 && !live ? (
            <p className="py-10 text-center text-sm text-ink-faint">
              Ask about {data.businessName}’s jobs, or type <code className="font-mono">/</code> for commands.
            </p>
          ) : null}
          {data.messages.map((m) =>
            m.role === "user" ? (
              <UserBubble key={m.id} text={m.content} />
            ) : (
              <div key={m.id} className="space-y-2">
                <Answer>
                  <MessageText text={m.content} />
                  {m.status !== "complete" ? (
                    <p className="mt-2 text-xs text-warn">
                      {m.status === "cut_off" ? "Stopped before the end." : "This answer failed part-way."}
                    </p>
                  ) : null}
                </Answer>
                {m.drafts.map((d) => (
                  <BlogDraftCard key={d.receiptId ?? d.slug} draft={d} />
                ))}
              </div>
            ),
          )}
          {live ? (
            <>
              <UserBubble text={live.userText} />
              <Answer>
                {live.activity ? <p className="mb-1.5 text-xs text-ink-faint">{live.activity}</p> : null}
                {live.answer ? <MessageText text={live.answer} /> : <span className="text-ink-faint">Working…</span>}
              </Answer>
            </>
          ) : null}
          <div ref={end} />
        </div>
      </div>

      {engine && !engine.available ? (
        <p className="mx-3 mb-2 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">
          {engine.label} is unavailable: {engine.reason}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mx-3 mb-2 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      ) : null}
      <Composer
        disabled={!engine?.available}
        draft={draft}
        setDraft={setDraft}
        onSend={() => void send()}
        busy={busy}
        onStop={() => abort.current?.abort()}
        workspaceHref={`/chat?c=${conversation.id}`}
      />
    </>
  );
}

/**
 * The message box, with "+" for what can be added to a conversation: a GitHub
 * repository (linked in the workspace, where the picker and file browser are),
 * skills, and uploads. The last two are not built yet and say so.
 */
function Composer({
  disabled,
  draft,
  setDraft,
  onSend,
  busy,
  onStop,
  workspaceHref,
}: {
  disabled: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  onStop: () => void;
  workspaceHref: string | null;
}) {
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!busy && draft.trim()) onSend();
    }
  }

  return (
    <div className="flex-none px-3 pb-3">
      <div
        className="rounded-2xl border border-line bg-surface shadow-card focus-within:border-brand
                   focus-within:outline-2 focus-within:outline-brand/30"
      >
        <label className="sr-only" htmlFor="chat-dock-input">
          Message Chat Boss
        </label>
        <textarea
          id="chat-dock-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={2}
          maxLength={20000}
          placeholder={disabled ? "Chat Boss isn’t available" : "Ask Chat Boss anything…"}
          className="block max-h-48 w-full resize-none rounded-t-2xl bg-transparent px-3.5 pt-3 text-sm text-ink
                     outline-none placeholder:text-ink-faint disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div ref={wrap} className="relative">
            <button
              type="button"
              onClick={() => setMenu((v) => !v)}
              disabled={disabled}
              aria-expanded={menu}
              aria-haspopup="menu"
              aria-label="Add to the conversation"
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-sunk
                         hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="plus" className="h-[18px] w-[18px]" />
            </button>
            {menu ? (
              <div
                role="menu"
                className="absolute bottom-full left-0 z-10 mb-2 w-64 overflow-hidden rounded-xl border border-line
                           bg-surface py-1 shadow-card-lg"
              >
                {workspaceHref ? (
                  <Link role="menuitem" href={workspaceHref} className={addItem}>
                    <Icon name="github" className="h-4 w-4" />
                    <span className="flex-1">GitHub repository</span>
                    <span className="text-[11px] text-ink-faint">in workspace</span>
                  </Link>
                ) : null}
                <span role="menuitem" aria-disabled className={`${addItem} cursor-not-allowed opacity-60`}>
                  <Icon name="sparkle" className="h-4 w-4" />
                  <span className="flex-1">Skills</span>
                  <span className="text-[11px] text-ink-faint">coming soon</span>
                </span>
                <span role="menuitem" aria-disabled className={`${addItem} cursor-not-allowed opacity-60`}>
                  <Icon name="upload" className="h-4 w-4" />
                  <span className="flex-1">Upload a file</span>
                  <span className="text-[11px] text-ink-faint">coming soon</span>
                </span>
              </div>
            ) : null}
          </div>
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || !draft.trim()}
              className="rounded-lg bg-brand-surface px-3 py-1.5 text-[13px] font-semibold text-brand-on-surface
                         hover:bg-brand-surface-hover disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const addItem = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-ink hover:bg-sunk";

function apply(prev: Live, event: WireEvent): Live {
  switch (event.type) {
    case "text":
      return { ...prev, answer: prev.answer + event.text };
    case "tool":
      return { ...prev, activity: event.phase === "start" ? `Running ${event.name}…` : null };
    case "done":
      return { ...prev, finished: true };
    default:
      return prev;
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand-surface px-3.5 py-2 text-sm text-brand-on-surface">
        {text}
      </div>
    </div>
  );
}

function Answer({ children }: { children: ReactNode }) {
  return <div className="text-sm leading-relaxed text-ink">{children}</div>;
}
