import Link from "next/link";
import type { RequestCard } from "@/lib/db";
import { createDriveFolderAction } from "./actions";

/**
 * Requests, as cards.
 *
 * Everything that has come IN — an estimate enquiry off a client's website, a
 * job somebody raised in the portal — laid out so the whole enquiry is readable
 * without opening anything. The point of a card here rather than a table row is
 * that a request is mostly prose: a name, an address, a paragraph about a roof.
 * A row truncates all of that to nothing useful.
 *
 * Each card can be given a folder in Google Drive, with the request written
 * into it. That is a button rather than something that happens automatically,
 * because most enquiries never become work and a Drive full of empty folders is
 * worse than no folders at all.
 */

const STATUS_PILL: Record<string, string> = {
  draft: "bg-sunk text-ink-faint",
  open: "bg-brand-soft text-brand",
  in_progress: "bg-warn/15 text-warn",
  awaiting_approval: "bg-warn/15 text-warn",
  changes_requested: "bg-bad/10 text-bad",
  approved: "bg-good/10 text-good",
  completed: "bg-good/10 text-good",
  cancelled: "bg-sunk text-ink-faint",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "New",
  in_progress: "In progress",
  awaiting_approval: "Awaiting approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Shown at the top of a card, in this order, when present. */
const HEADLINE_FIELDS = ["name", "email", "phone", "service"];

export function Requests({
  requests,
  canFile,
  driveConfigured,
}: {
  requests: RequestCard[];
  /** Whether this session is scoped to one company, so it may write. */
  canFile: boolean;
  driveConfigured: boolean;
}) {
  // `aria-labelledby` names the section, so it is a landmark a screen reader
  // can jump to rather than an anonymous block — and so anything looking for
  // "the requests board" finds this and not the recent-jobs list above it.
  return (
    <section aria-labelledby="requests-heading" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="requests-heading" className="text-sm font-semibold text-ink">
          Requests
        </h2>
        <p className="text-xs text-ink-faint">
          Estimates, quotes and enquiries sent in — newest first
        </p>
      </div>

      {requests.length === 0 ? (
        <p className="mt-3 rounded-xl border border-line bg-surface px-5 py-10 text-center text-sm text-ink-faint shadow-card">
          Nothing has come in yet.
        </p>
      ) : (
        <ul className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {requests.map((request) => (
            <Card
              key={request.id}
              request={request}
              canFile={canFile}
              driveConfigured={driveConfigured}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Card({
  request,
  canFile,
  driveConfigured,
}: {
  request: RequestCard;
  canFile: boolean;
  driveConfigured: boolean;
}) {
  const details = request.details ?? {};
  const headline = HEADLINE_FIELDS.filter((key) => details[key]);
  const message = details.message ?? details.notes ?? null;
  const rest = Object.keys(details).filter(
    (key) => !headline.includes(key) && key !== "message" && key !== "notes",
  );

  return (
    <li className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tabular-nums text-ink-faint">
            {request.ref} · {request.organizationName}
          </p>
          <h3 className="mt-1 text-sm font-semibold leading-snug text-ink text-balance">
            <Link
              href={`/jobs/${request.id}`}
              className="transition-colors hover:text-brand focus-visible:outline-2
                         focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {request.title}
            </Link>
          </h3>
        </div>
        <span
          className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-medium ${
            STATUS_PILL[request.status] ?? "bg-sunk text-ink-faint"
          }`}
        >
          {STATUS_LABEL[request.status] ?? request.status}
        </span>
      </div>

      {headline.length > 0 ? (
        <dl className="mt-3 space-y-1">
          {headline.map((key) => (
            <div key={key} className="flex gap-2 text-xs">
              <dt className="w-16 flex-none uppercase tracking-wider text-ink-faint">
                {key}
              </dt>
              <dd className="min-w-0 truncate text-ink">{details[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {message ? (
        <p className="mt-3 line-clamp-4 whitespace-pre-wrap rounded-lg bg-sunk px-3 py-2 text-xs leading-relaxed text-ink-soft">
          {message}
        </p>
      ) : null}

      {rest.length > 0 ? (
        <p className="mt-2 text-[11px] text-ink-faint">
          + {rest.length} more {rest.length === 1 ? "field" : "fields"} on the job
        </p>
      ) : null}

      {/* Pushes the footer down so cards of different heights line their actions up. */}
      <div className="flex-1" />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
        <span className="text-[11px] tabular-nums text-ink-faint">
          {new Date(request.createdAt).toLocaleDateString("en-CA", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </span>

        {request.driveFolderUrl ? (
          <a
            href={request.driveFolderUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-line px-2.5 py-1 text-xs font-medium
                       text-ink-soft transition-colors hover:bg-sunk
                       focus-visible:outline-2 focus-visible:outline-offset-2
                       focus-visible:outline-brand"
          >
            Open Drive folder ↗
          </a>
        ) : canFile && driveConfigured ? (
          <form action={createDriveFolderAction}>
            <input type="hidden" name="jobId" value={request.id} />
            <button
              type="submit"
              className="rounded-md border border-line px-2.5 py-1 text-xs font-medium
                         text-brand transition-colors hover:bg-brand-soft
                         focus-visible:outline-2 focus-visible:outline-offset-2
                         focus-visible:outline-brand"
            >
              Create Drive folder
            </button>
          </form>
        ) : (
          <span className="text-[11px] text-ink-faint">
            {driveConfigured ? "Choose a client to file" : "Drive not connected"}
          </span>
        )}
      </div>
    </li>
  );
}
