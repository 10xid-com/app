"use client";

import { useActionState, useEffect, useOptimistic, useRef } from "react";
import { CsrfInput, CsrfProvider } from "../../chat/csrf";
import { NotesThread, type ThreadNote } from "../../_components/notes-thread";
import { sendJobNoteAction, type NoteState } from "../actions";

/**
 * A job's notes and the box to add to them, which answers at once.
 *
 * Pressing Send puts the note in the thread straight away, marked "Sending…",
 * and empties the box; the server's answer then replaces it with the real
 * one. Waiting on the round trip before showing anything is what made sending
 * feel slow from far away, while the server itself answered in a fraction of a
 * second. If the server refuses (somebody moved the job, the person is not on
 * the team), the pending note goes away, the text goes back in the box, and
 * the reason is said.
 */

type Person = { id: string; label: string; isMe: boolean };
type Note = Omit<ThreadNote, "at"> & { at: string };

const START: NoteState = { error: null, notice: null, at: 0 };

export function JobNotes({
  jobId,
  holderId,
  notes,
  people,
  keepLabel,
  mayNote,
  mayAssign,
  csrfToken,
}: {
  jobId: string;
  /** Who has the job now, as the page saw it; empty for nobody. */
  holderId: string;
  notes: Note[];
  /** People it can be handed to: everyone on the team but its current holder. */
  people: Person[];
  /** "Keep with Rana", "Keep with me", or "Nobody (just a note)". */
  keepLabel: string;
  mayNote: boolean;
  mayAssign: boolean;
  csrfToken: string;
}) {
  const [state, send, pending] = useActionState(sendJobNoteAction, START);
  const [shown, addPending] = useOptimistic<Note[], Note>(notes, (current, note) => [...current, note]);
  const form = useRef<HTMLFormElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const lastBody = useRef("");

  // Refused: give the person their words back.
  useEffect(() => {
    if (state.error && box.current && !box.current.value) box.current.value = lastBody.current;
  }, [state]);

  function submit(data: FormData) {
    const body = String(data.get("body") ?? "").trim();
    const handTo = String(data.get("handTo") ?? "keep");
    lastBody.current = body;
    if (body) {
      const to = people.find((p) => p.id === handTo);
      addPending({
        id: `pending-${Date.now()}`,
        author: "You",
        at: new Date().toISOString(),
        body,
        handedTo: to ? (to.isMe ? "you" : to.label) : null,
        pending: true,
      });
    }
    // Empty the box now: the note is already in the thread. (React would
    // only reset the form once the server has answered.)
    if (box.current) box.current.value = "";
    send(data);
  }

  const canWrite = mayNote || mayAssign;

  return (
    <NotesThread notes={shown.map((n) => ({ ...n, at: new Date(n.at) }))}>
      {canWrite ? (
        <CsrfProvider value={csrfToken}>
          <form ref={form} action={submit} className="grid gap-3">
            <CsrfInput />
            <input type="hidden" name="jobId" value={jobId} />
            <input type="hidden" name="from" value={holderId} />
            {state.error ? (
              <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
                {state.error}
              </p>
            ) : state.notice ? (
              <p role="status" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink">
                {state.notice}
              </p>
            ) : null}
            <label htmlFor="note-body" className="sr-only">
              Note
            </label>
            <textarea
              ref={box}
              id="note-body"
              name="body"
              rows={3}
              maxLength={4000}
              placeholder={mayNote ? "Write a note for the team…" : "Add a note to go with it (optional)…"}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink
                         placeholder:text-ink-faint focus:border-brand focus:outline-2 focus:outline-brand/30"
            />
            <div className="flex flex-wrap items-center gap-2">
              {mayAssign ? (
                <>
                  <label htmlFor="hand-to" className="text-sm text-ink-soft">
                    Hand to
                  </label>
                  <select
                    id="hand-to"
                    name="handTo"
                    defaultValue="keep"
                    className="min-w-0 max-w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink
                               focus:border-brand focus:outline-2 focus:outline-brand/30"
                  >
                    <option value="keep">{keepLabel}</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.isMe ? `Me (${p.label})` : p.label}
                      </option>
                    ))}
                    {holderId ? <option value="nobody">Nobody: take it off them</option> : null}
                  </select>
                </>
              ) : (
                <input type="hidden" name="handTo" value="keep" />
              )}
              {pending ? <span className="ml-auto text-xs text-ink-faint">Sending…</span> : null}
              <button
                type="submit"
                className={`${pending ? "" : "ml-auto"} rounded-lg bg-brand-surface px-4 py-1.5 text-sm font-semibold text-brand-on-surface
                           transition-colors duration-150 hover:bg-brand-surface-hover
                           focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`}
              >
                Send
              </button>
            </div>
          </form>
        </CsrfProvider>
      ) : null}
    </NotesThread>
  );
}
