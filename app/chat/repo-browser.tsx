"use client";

import { useCallback, useEffect, useState } from "react";
import { addRepoContextAction } from "./actions";
import type { WorkspaceData } from "./types";
import { CsrfInput } from "./csrf";

/**
 * Right, Repository tab: the conversation's repository at its branch.
 *
 * The tree loads one folder at a time, on demand. Each entry shows whether it
 * is in the conversation's context, whether it differs from the default
 * branch, and whether it is a secret that can be seen listed but never read.
 */

type Entry = { path: string; type: "file" | "dir"; size?: number; secret: boolean };
type Changed = { path: string; status: string; additions: number; deletions: number };
type Hit = { path: string; line?: number; preview?: string };

export function RepoBrowser({ data }: { data: WorkspaceData }) {
  const current = data.repository.current;
  const conversationId = data.conversation?.id;
  const [dirs, setDirs] = useState<Record<string, Entry[] | "loading" | { error: string }>>({});
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [changed, setChanged] = useState<Changed[] | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"filename" | "text">("filename");
  const [results, setResults] = useState<{ hits: Hit[]; note: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = conversationId ? `/api/workspace/conversations/${conversationId}/repository` : null;

  const loadDir = useCallback(
    async (path: string) => {
      if (!base) return;
      setDirs((d) => ({ ...d, [path]: "loading" }));
      const res = await fetch(`${base}?view=tree&path=${encodeURIComponent(path)}`);
      const body = await res.json().catch(() => ({}));
      setDirs((d) => ({ ...d, [path]: res.ok ? body.entries : { error: body.error ?? "Could not load." } }));
    },
    [base],
  );

  useEffect(() => {
    if (!current || !base) return;
    let stale = false;
    void (async () => {
      await loadDir("");
      if (current.branch === current.defaultBranch) return;
      const res = await fetch(`${base}?view=changed`);
      const body = await res.json().catch(() => ({}));
      if (!stale && res.ok) setChanged(body.files);
    })();
    return () => {
      stale = true;
    };
  }, [base, current, loadDir]);

  if (!data.conversation || !conversationId) return <Note text="Start a conversation to browse a repository." />;
  if (!current) {
    return <Note text="No repository is selected for this conversation. Choose one on the left — it is read-only." />;
  }

  const inContext = new Set(data.context.filter((c) => c.path !== null).map((c) => `${c.kind}:${c.path}`));
  const changedPaths = new Map((changed ?? []).map((f) => [f.path, f.status]));
  const recent = recentFiles(data, current.name);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!base || query.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`${base}?view=search&mode=${mode}&q=${encodeURIComponent(query.trim())}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Search failed.");
      const note =
        mode === "text"
          ? `Searched ${body.filesSearched} of ${body.filesEligible} text files${body.truncated ? " — results may be incomplete" : ""}.`
          : body.truncated
            ? "First matches only."
            : "";
      setResults({ hits: body.hits, note });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  function toggle(path: string) {
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirs[path]) void loadDir(path);
      }
      return next;
    });
  }

  function renderDir(path: string, depth: number): React.ReactNode {
    const entries = dirs[path];
    if (!entries || entries === "loading") return <li className="text-xs text-ink-faint" style={{ paddingLeft: depth * 12 }}>Loading…</li>;
    if (!Array.isArray(entries)) return <li className="text-xs text-bad" style={{ paddingLeft: depth * 12 }}>{entries.error}</li>;
    if (entries.length === 0) return <li className="text-xs text-ink-faint" style={{ paddingLeft: depth * 12 }}>Empty</li>;
    return entries.map((e) => {
      const name = e.path.split("/").at(-1);
      const isOpen = open.has(e.path);
      const kind = e.type === "dir" ? "folder" : "file";
      const status = changedPaths.get(e.path);
      return (
        <li key={e.path}>
          <div className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-sunk" style={{ paddingLeft: depth * 12 + 4 }}>
            {e.type === "dir" ? (
              <button type="button" onClick={() => toggle(e.path)} aria-expanded={isOpen} className="min-w-0 flex-1 truncate text-left text-[13px] text-ink">
                <span className="mr-1 inline-block w-3 text-ink-faint">{isOpen ? "▾" : "▸"}</span>
                {name}/
              </button>
            ) : (
              <span className={`min-w-0 flex-1 truncate pl-4 text-[13px] ${e.secret ? "text-ink-faint" : "text-ink"}`} title={e.path}>
                {name}
              </span>
            )}
            {e.secret ? <Badge tone="faint">secret</Badge> : null}
            {status ? <Badge tone="warn">{status}</Badge> : null}
            {inContext.has(`${kind}:${e.path}`) ? (
              <Badge tone="brand">in context</Badge>
            ) : e.secret ? null : (
              <AddButton conversationId={conversationId!} kind={kind} path={e.path} />
            )}
          </div>
          {e.type === "dir" && isOpen ? <ul>{renderDir(e.path, depth + 1)}</ul> : null}
        </li>
      );
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[13px] font-semibold text-ink">{current.name}</p>
        <p className="text-[11px] text-ink-faint">
          {current.branch}
          {current.branch === current.defaultBranch ? " (default)" : ` — compared with ${current.defaultBranch}`} · read-only
        </p>
      </div>

      <form onSubmit={search} className="space-y-1.5">
        <div className="flex gap-1.5">
          <label className="sr-only" htmlFor="repo-search">
            Search the repository
          </label>
          <input
            id="repo-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            minLength={2}
            maxLength={200}
            placeholder={mode === "filename" ? "Find a file by name" : "Find text in files"}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm placeholder:text-ink-faint"
          />
          <button type="submit" disabled={searching} className="rounded-md border border-line px-2.5 text-xs font-medium text-ink-soft hover:bg-sunk">
            {searching ? "…" : "Search"}
          </button>
        </div>
        <div className="flex gap-3 text-[11px] text-ink-soft">
          {(["filename", "text"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="radio" name="repo-search-mode" checked={mode === m} onChange={() => setMode(m)} />
              {m === "filename" ? "File names" : "File contents"}
            </label>
          ))}
        </div>
      </form>
      {error ? <p className="text-xs text-bad">{error}</p> : null}
      {results ? (
        <section aria-label="Search results">
          {results.note ? <p className="mb-1 text-[11px] text-ink-faint">{results.note}</p> : null}
          {results.hits.length === 0 ? (
            <Note text="No matches." />
          ) : (
            <ul className="space-y-0.5">
              {results.hits.map((h, i) => (
                <li key={`${h.path}:${h.line ?? i}`} className="flex items-start gap-1.5 rounded px-1 py-0.5 hover:bg-sunk">
                  <span className="min-w-0 flex-1 break-all text-[12px] text-ink">
                    {h.path}
                    {h.line ? <span className="text-ink-faint">:{h.line}</span> : null}
                    {h.preview ? <span className="block truncate font-mono text-[11px] text-ink-faint">{h.preview}</span> : null}
                  </span>
                  {inContext.has(`file:${h.path}`) ? (
                    <Badge tone="brand">in context</Badge>
                  ) : (
                    <AddButton conversationId={conversationId} kind="file" path={h.path} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {recent.length ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold text-ink-soft">Recently read in this conversation</h3>
          <ul className="space-y-0.5">
            {recent.map((p) => (
              <li key={p} className="flex items-center gap-1.5 px-1 text-[12px] text-ink">
                <span className="min-w-0 flex-1 truncate">{p}</span>
                {inContext.has(`file:${p}`) ? <Badge tone="brand">in context</Badge> : <AddButton conversationId={conversationId} kind="file" path={p} />}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {changed && changed.length ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold text-ink-soft">
            Changed from {current.defaultBranch} ({changed.length})
          </h3>
          <ul className="space-y-0.5">
            {changed.map((f) => (
              <li key={f.path} className="flex items-center gap-1.5 px-1 text-[12px]">
                <Badge tone="warn">{f.status}</Badge>
                <span className="min-w-0 flex-1 truncate text-ink">{f.path}</span>
                <span className="text-[11px] text-ink-faint">
                  +{f.additions} −{f.deletions}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="mb-1 text-xs font-semibold text-ink-soft">Files</h3>
        <ul aria-label="Repository files">{renderDir("", 0)}</ul>
      </section>
    </div>
  );
}

function recentFiles(data: WorkspaceData, repoName: string): string[] {
  const seen: string[] = [];
  for (const run of [...data.runs].reverse()) {
    if (run.repository?.name !== repoName) continue;
    for (const r of run.receipts) {
      const path = typeof r.detail?.["repository"] === "string" && r.kind === "file" ? r.ref?.split(":").slice(1).join(":") : null;
      if (path && !seen.includes(path)) seen.push(path);
      if (seen.length >= 8) return seen;
    }
  }
  return seen;
}

function AddButton({ conversationId, kind, path }: { conversationId: string; kind: "file" | "folder"; path: string }) {
  return (
    <form action={addRepoContextAction}>
      <CsrfInput />
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="path" value={path} />
      <button
        type="submit"
        aria-label={`Add ${path} to context`}
        className="rounded px-1 text-[11px] font-medium text-brand opacity-70 hover:underline group-hover:opacity-100"
      >
        + context
      </button>
    </form>
  );
}

function Badge({ tone, children }: { tone: "brand" | "warn" | "faint"; children: React.ReactNode }) {
  const cls =
    tone === "brand" ? "bg-brand-soft text-brand" : tone === "warn" ? "bg-warn/10 text-warn" : "bg-sunk text-ink-faint";
  return <span className={`flex-none rounded px-1 text-[10px] font-semibold uppercase ${cls}`}>{children}</span>;
}

function Note({ text }: { text: string }) {
  return <p className="text-xs leading-relaxed text-ink-faint">{text}</p>;
}
