"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { CSRF_FIELD } from "@/lib/auth/csrf-names";
import { Icon } from "../_components/icons";
import { panelRepositoryAction } from "./actions";
import { useCsrf } from "./csrf";

/**
 * Adding a GitHub repository from the Chat Boss panel, in place — the way
 * Claude Code adds one to a session — rather than by going to the workspace.
 *
 * The picker lists the repositories already linked to this business, then the
 * ones the GitHub App can see that nobody has linked yet (fetched only when the
 * picker opens). Picking either puts it on the conversation at its default
 * branch, linking it to the business first if it needs to be
 * (panelRepositoryAction). The chip above the message box then shows it, with
 * its branch to change and × to take it off.
 *
 * Read-only, like everywhere else: answers read the branch, nothing is written.
 */

export type DockRepositories = {
  conversationId: string;
  /** Linked to this business already. */
  linked: { id: string; externalId: number; name: string; defaultBranch: string }[];
  current: { id: string; name: string; branch: string } | null;
};

type Available = { externalId: number; name: string; private: boolean; linkedHere: boolean };

/** Calls the action with the session's token and refreshes the page around the panel. */
function useSetRepository(conversationId: string) {
  const csrf = useCsrf();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function set(fields: Record<string, string>, onDone?: () => void) {
    setError(null);
    start(async () => {
      const form = new FormData();
      form.set(CSRF_FIELD, csrf);
      form.set("conversationId", conversationId);
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const result = await panelRepositoryAction(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone?.();
      router.refresh();
    });
  }

  return { set, pending, error };
}

export function RepoPicker({ repos, businessName, onClose }: { repos: DockRepositories; businessName: string; onClose: () => void }) {
  const { set, pending, error } = useSetRepository(repos.conversationId);
  const [query, setQuery] = useState("");
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    let stale = false;
    fetch("/api/workspace/repositories")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (stale) return;
        if (!res.ok) throw new Error(body.error ?? "Repositories could not be loaded.");
        setAvailable(body.repositories);
      })
      .catch((err: Error) => !stale && setLoadError(err.message));
    return () => {
      stale = true;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(needle);
  const linkedIds = new Set(repos.linked.map((r) => r.externalId));
  const linked = repos.linked.filter((r) => matches(r.name));
  const more = (available ?? []).filter((r) => !r.linkedHere && !linkedIds.has(r.externalId) && matches(r.name));

  function pickFirst() {
    if (linked[0]) set({ repositoryId: linked[0].id }, onClose);
    else if (more[0]) set({ externalId: String(more[0].externalId) }, onClose);
  }

  return (
    <div
      role="dialog"
      aria-label="Add a GitHub repository"
      className="absolute bottom-full left-0 z-10 mb-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border
                 border-line bg-surface shadow-card-lg"
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <Icon name="github" className="h-4 w-4 flex-none text-ink-soft" />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              pickFirst();
            }
          }}
          placeholder="Search repositories"
          aria-label="Search repositories"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      <div className="max-h-72 overflow-y-auto py-1" aria-busy={pending}>
        {linked.length ? <Heading text={`Linked to ${businessName}`} /> : null}
        {linked.map((r) => (
          <Row
            key={r.id}
            name={r.name}
            note={repos.current?.id === r.id ? "in use" : r.defaultBranch}
            disabled={pending || repos.current?.id === r.id}
            onPick={() => set({ repositoryId: r.id }, onClose)}
          />
        ))}

        {more.length ? <Heading text="On GitHub" /> : null}
        {more.map((r) => (
          <Row
            key={r.externalId}
            name={r.name}
            note={r.private ? "private" : "public"}
            disabled={pending}
            onPick={() => set({ externalId: String(r.externalId) }, onClose)}
          />
        ))}

        {available === null && !loadError ? <p className="px-3 py-2 text-xs text-ink-faint">Asking GitHub…</p> : null}
        {loadError ? <p className="px-3 py-2 text-xs text-bad">{loadError}</p> : null}
        {available !== null && linked.length === 0 && more.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-faint">
            {needle
              ? `No repository matches “${query.trim()}”.`
              : "No repositories yet. Install the GitHub App on a repository to see it here."}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="border-t border-line-soft px-3 py-2 text-xs text-bad">
          {error}
        </p>
      ) : null}
      <p className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-ink-faint">
        {pending
          ? "Adding…"
          : `Read-only. A repository picked from GitHub is linked to ${businessName}, and only its conversations can read it.`}
      </p>
    </div>
  );
}

function Heading({ text }: { text: string }) {
  return <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{text}</p>;
}

function Row({ name, note, disabled, onPick }: { name: string; note: string; disabled: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-ink hover:bg-sunk
                 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="flex-none text-[11px] text-ink-faint">{note}</span>
    </button>
  );
}

/**
 * The repository on the conversation, above the message box: its name, its
 * branch (a menu of the others), and × to take it off.
 */
export function RepoChip({ repos }: { repos: DockRepositories & { current: NonNullable<DockRepositories["current"]> } }) {
  const { current, conversationId } = repos;
  const { set, pending, error } = useSetRepository(conversationId);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    if (branches === null) {
      fetch(`/api/workspace/conversations/${conversationId}/repository?view=branches&repository=${current.id}`)
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? "Branches could not be loaded.");
          setBranches(body.branches);
        })
        .catch((err: Error) => setLoadError(err.message));
    }
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, branches, conversationId, current.id]);

  const defaultBranch = repos.linked.find((r) => r.id === current.id)?.defaultBranch;

  return (
    <div className="px-2 pt-2">
      <div ref={wrap} className="relative flex items-center gap-1.5">
        <span
          className={`flex min-w-0 items-center gap-1.5 rounded-lg border border-line bg-sunk py-1 pl-2 pr-1 text-xs text-ink ${
            pending ? "opacity-60" : ""
          }`}
        >
          <Icon name="github" className="h-3.5 w-3.5 flex-none text-ink-soft" />
          <span className="truncate font-medium">{current.name}</span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={pending}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={`Branch: ${current.branch}. Change branch`}
            className="flex-none rounded px-1 font-mono text-[11px] text-ink-soft hover:bg-surface hover:text-ink"
          >
            {current.branch} ▾
          </button>
          <button
            type="button"
            onClick={() => set({})}
            disabled={pending}
            aria-label={`Remove ${current.name} from this conversation`}
            className="grid h-5 w-5 flex-none place-items-center rounded text-ink-faint hover:bg-surface hover:text-ink"
          >
            <Icon name="close" className="h-3 w-3" />
          </button>
        </span>

        {open ? (
          <div
            role="listbox"
            aria-label="Branches"
            className="absolute bottom-full left-0 z-10 mb-1 max-h-60 w-56 overflow-y-auto rounded-xl border border-line
                       bg-surface py-1 shadow-card-lg"
          >
            {branches === null && !loadError ? <p className="px-3 py-2 text-xs text-ink-faint">Loading branches…</p> : null}
            {loadError ? <p className="px-3 py-2 text-xs text-bad">{loadError}</p> : null}
            {branches?.map((b) => (
              <button
                key={b}
                type="button"
                role="option"
                aria-selected={b === current.branch}
                disabled={pending || b === current.branch}
                onClick={() => set({ repositoryId: current.id, branch: b }, () => setOpen(false))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-ink hover:bg-sunk
                           disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="min-w-0 flex-1 truncate">{b}</span>
                {b === current.branch ? <span className="font-sans text-[11px] text-brand">in use</span> : null}
                {b === defaultBranch && b !== current.branch ? (
                  <span className="font-sans text-[11px] text-ink-faint">default</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
