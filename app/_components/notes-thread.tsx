import type { ReactNode } from "react";

/**
 * What the people of a business have said about one piece of work, oldest
 * first, with the box to add to it underneath.
 *
 * Presentational only, and free of any one record's shape: jobs use it now,
 * and orders will when they exist. Bodies are rendered as text, never markup.
 */

export type ThreadNote = {
  id: string;
  author: string;
  at: Date;
  body: string;
  /** Set on the note that went with a handover: who the work went to. */
  handedTo: string | null;
  /** Shown the moment it is sent, before the server has it. */
  pending?: boolean;
};

export function NotesThread({
  notes,
  children,
}: {
  notes: ThreadNote[];
  /** The form for a new note, if this person may write one. */
  children?: ReactNode;
}) {
  return (
    <section id="notes" className="mt-6 scroll-mt-6">
      <h2 className="mb-3 text-sm font-semibold text-ink">Notes</h2>
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {notes.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-faint">
            Nothing said yet. Leave a note for the team, or hand this to somebody.
          </p>
        ) : (
          <ol className="divide-y divide-line-soft">
            {notes.map((note) => (
              <li key={note.id} className={`px-4 py-3 ${note.pending ? "opacity-60" : ""}`} aria-busy={note.pending}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-ink">{note.author}</span>
                  {note.handedTo ? (
                    <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">
                      handed to {note.handedTo}
                    </span>
                  ) : null}
                  {note.pending ? (
                    <span className="ml-auto text-xs text-ink-faint">Sending…</span>
                  ) : (
                    <time
                      dateTime={note.at.toISOString()}
                      className="ml-auto font-mono text-xs tabular-nums text-ink-faint"
                    >
                      {note.at.toISOString().replace("T", " ").slice(0, 16)}
                    </time>
                  )}
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap break-words text-ink">{note.body}</p>
              </li>
            ))}
          </ol>
        )}
        {children ? <div className="border-t border-line bg-sunk/40 p-4">{children}</div> : null}
      </div>
    </section>
  );
}
