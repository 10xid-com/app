"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

/**
 * The chat itself: a conversation, a box to type in, and a choice of model.
 *
 * The conversation lives in this component's state and nowhere else — not the
 * database, not localStorage. Refreshing the page starts a new one. That is the
 * honest default for a tool people will paste client work into: nothing is
 * kept that nobody decided to keep.
 *
 * Answers stream in as they are written, because the free models can take
 * several seconds to finish and an empty box for that long reads as broken.
 */

type Model = { id: string; label: string };
type Turn = {
  role: "user" | "assistant";
  content: string;
  /** Assistant turns only: which model actually answered. */
  model?: string;
  /** Assistant turns only: the answer did not finish. */
  cutOff?: boolean;
};

export function ChatBox({ models }: { models: Model[] }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(models[0]!.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Follow the answer down the page as it grows.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  // Anything typed before the page finished loading is in the box but not in
  // state, which leaves Send disabled beside a message that is plainly there.
  // Adopt it once, on mount.
  useEffect(() => {
    const early = input.current?.value;
    if (early) setDraft(early);
  }, []);

  // Stop any answer still streaming if the page is left.
  useEffect(() => () => abort.current?.abort(), []);

  const labelFor = (id: string) => models.find((m) => m.id === id)?.label ?? id;

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;

    const history: Turn[] = [...turns, { role: "user", content: text }];
    setTurns([...history, { role: "assistant", content: "", model }]);
    setDraft("");
    setError(null);
    setBusy(true);

    const controller = new AbortController();
    abort.current = controller;

    // Only role and content go to the server. A turn that came back empty —
    // stopped before its first word — is left out, because the model API
    // rejects empty messages.
    const messages = history
      .filter((t) => t.content.length > 0)
      .map(({ role, content }) => ({ role, content }));

    const update = (patch: Partial<Turn>) =>
      setTurns((prev) => {
        // "New chat" pressed mid-answer has already emptied the list.
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const last = next[next.length - 1]!;
        next[next.length - 1] = { ...last, ...patch };
        return next;
      });

    let answer = "";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        if (res.status === 401) {
          router.push("/auth/login?next=/chat");
          return;
        }
        throw new Error(body?.error ?? `The chat failed (${res.status}).`);
      }

      update({ model: res.headers.get("X-Chat-Model") ?? model });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        update({ content: answer });
      }
      answer += decoder.decode();
      update({ content: answer });
    } catch (err) {
      if (controller.signal.aborted) {
        update({ cutOff: answer.length > 0 });
      } else if (answer.length > 0) {
        update({ cutOff: true });
        setError("The answer was cut off. Send again to retry.");
      } else {
        // Nothing arrived: take the empty bubble away and put the question
        // back in the box, so retrying is one press.
        setTurns(history.slice(0, -1));
        setDraft(text);
        setError(err instanceof Error ? err.message : "The chat failed.");
      }
    } finally {
      abort.current = null;
      setBusy(false);
      input.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a new line. Not while an IME is composing,
    // where Enter confirms the character rather than the message.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function newChat() {
    abort.current?.abort();
    setTurns([]);
    setError(null);
    input.current?.focus();
  }

  return (
    <div className="flex min-h-[calc(100dvh-10rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Chat</h1>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="chat-model">
            Model
          </label>
          <select
            id="chat-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink
                       focus:border-brand focus:outline-2 focus:outline-brand/30"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} (free)
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={newChat}
            disabled={turns.length === 0}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-soft
                       transition-colors hover:bg-surface disabled:opacity-50
                       focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            New chat
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Free models through OpenRouter. Nothing here is saved — refreshing starts
        over. Free providers may keep what you send, so leave out anything a
        client would not want shared.
      </p>

      <div className="mt-6 flex-1 space-y-4" aria-live="polite">
        {turns.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-faint">
            Ask anything — draft an email, summarise a brief, plan a job.
          </p>
        ) : (
          turns.map((turn, i) =>
            turn.role === "user" ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-surface px-4 py-2.5 text-sm text-brand-on-surface">
                  {turn.content}
                </p>
              </div>
            ) : (
              <div key={i} className="flex flex-col items-start gap-1">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-line bg-surface px-4 py-2.5 text-sm leading-relaxed text-ink shadow-card">
                  {turn.content || (
                    <span className="text-ink-faint">Thinking…</span>
                  )}
                </div>
                <p className="px-1 text-[11px] text-ink-faint">
                  {labelFor(turn.model ?? "")}
                  {turn.cutOff ? " · stopped before the end" : ""}
                </p>
              </div>
            ),
          )
        )}
        <div ref={end} />
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
        >
          {error}
        </p>
      ) : null}

      <form
        onSubmit={send}
        className="sticky bottom-0 mt-4 flex items-end gap-2 bg-ground pb-4 pt-2"
      >
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <textarea
          id="chat-input"
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          maxLength={20000}
          autoFocus
          placeholder="Message — Enter to send, Shift+Enter for a new line"
          className="min-w-0 flex-1 resize-y rounded-xl border border-line bg-surface px-3 py-2.5
                     text-sm text-ink placeholder:text-ink-faint
                     focus:border-brand focus:outline-2 focus:outline-brand/30"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abort.current?.abort()}
            className="flex-none rounded-xl border border-line bg-surface px-4 py-2.5 text-sm
                       font-semibold text-ink transition-colors hover:bg-sunk
                       focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            className="flex-none rounded-xl bg-brand-surface px-4 py-2.5 text-sm font-semibold
                       text-brand-on-surface transition-colors hover:bg-brand-surface-hover
                       disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2
                       focus-visible:outline-brand"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
