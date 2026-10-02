"use client";

import { useEffect, useState } from "react";
import { linkRepositoryAction, setRepositoryAction, unlinkRepositoryAction } from "./actions";
import type { WorkspaceData } from "./types";

/**
 * Left: which repository and branch this conversation reads, and which
 * repositories belong to the client.
 *
 * Branches and installable repositories are fetched only when asked for, so
 * opening the workspace never waits on GitHub.
 */
export function RepoPicker({ data }: { data: WorkspaceData }) {
  const repo = data.repository;
  const conversationId = data.conversation?.id ?? null;

  if (!repo.configured) {
    return (
      <p className="mt-2 rounded-lg border border-dashed border-line p-3 text-xs leading-relaxed text-ink-faint">
        The GitHub App is not set up on this server, so no repository can be read.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {conversationId ? (
        <Selector key={`${repo.current?.id ?? "none"}:${repo.current?.branch ?? ""}`} data={data} conversationId={conversationId} />
      ) : (
        <p className="text-xs text-ink-faint">Start a conversation to choose a repository.</p>
      )}
      <Manage data={data} conversationId={conversationId} />
    </div>
  );
}

function Selector({ data, conversationId }: { data: WorkspaceData; conversationId: string }) {
  const repo = data.repository;
  const [repositoryId, setRepositoryId] = useState(repo.current?.id ?? "");
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(repo.current?.branch ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repositoryId) return;
    let stale = false;
    fetch(`/api/workspace/conversations/${conversationId}/repository?view=branches&repository=${repositoryId}`)
      .then(async (res) => {
        const body = await res.json();
        if (stale) return;
        if (!res.ok) throw new Error(body.error ?? "Branches could not be loaded.");
        setBranches(body.branches);
        setBranch((b) => (b && body.branches.includes(b) ? b : body.defaultBranch));
        setError(null);
      })
      .catch((err: Error) => !stale && setError(err.message));
    return () => {
      stale = true;
    };
  }, [conversationId, repositoryId]);

  if (repo.linked.length === 0) {
    return <p className="text-xs text-ink-faint">No repository is linked to this client yet.</p>;
  }

  const changed = repositoryId !== (repo.current?.id ?? "") || (repositoryId !== "" && branch !== (repo.current?.branch ?? ""));
  const defaultBranch = repo.linked.find((r) => r.id === repositoryId)?.defaultBranch;

  return (
    <form action={setRepositoryAction} className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <input type="hidden" name="conversationId" value={conversationId} />
      <label className="block text-xs text-ink-soft">
        Repository
        <select
          name="repositoryId"
          value={repositoryId}
          onChange={(e) => {
            setRepositoryId(e.target.value);
            setBranches(null);
            setBranch("");
          }}
          className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
        >
          <option value="">None</option>
          {repo.linked.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {repositoryId ? (
        <label className="block text-xs text-ink-soft">
          Branch
          <select
            name="branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={!branches}
            className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
          >
            {branches ? (
              branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === defaultBranch ? " (default)" : ""}
                </option>
              ))
            ) : (
              <option value={branch}>{branch || "Loading…"}</option>
            )}
          </select>
        </label>
      ) : null}
      {error ? <p className="text-xs text-bad">{error}</p> : null}
      {changed ? (
        <button
          type="submit"
          className="w-full rounded-md bg-brand-surface px-3 py-1.5 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
        >
          Use for this conversation
        </button>
      ) : repo.current ? (
        <p className="text-[11px] text-ink-faint">Read-only. Answers read this branch at its latest commit.</p>
      ) : null}
    </form>
  );
}

type Available = { externalId: number; name: string; private: boolean; linkedHere: boolean };

function Manage({ data, conversationId }: { data: WorkspaceData; conversationId: string | null }) {
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (available || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/workspace/repositories");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Repositories could not be loaded.");
      setAvailable(body.repositories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Repositories could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  const owner = data.client.isHouse ? "the house" : data.client.name;

  return (
    <details className="rounded-lg border border-line bg-surface" onToggle={(e) => e.currentTarget.open && void load()}>
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink-soft">
        Manage repositories for {owner}
      </summary>
      <div className="space-y-3 px-3 pb-3">
        {data.repository.linked.length ? (
          <ul className="space-y-1">
            {data.repository.linked.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-ink">{r.name}</span>
                <form action={unlinkRepositoryAction}>
                  <input type="hidden" name="repositoryId" value={r.id} />
                  {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
                  <button type="submit" className="text-ink-faint hover:text-bad">
                    Unlink
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <p className="text-[11px] font-semibold text-ink-soft">Link a repository the GitHub App can see</p>
          {loading ? <p className="mt-1 text-xs text-ink-faint">Asking GitHub…</p> : null}
          {error ? <p className="mt-1 text-xs text-bad">{error}</p> : null}
          {available && available.filter((r) => !r.linkedHere).length === 0 ? (
            <p className="mt-1 text-xs text-ink-faint">
              Nothing else to link. Install the GitHub App on more repositories to see them here.
            </p>
          ) : null}
          <ul className="mt-1 space-y-1">
            {available
              ?.filter((r) => !r.linkedHere)
              .map((r) => (
                <li key={r.externalId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-ink">
                    {r.name}
                    {r.private ? <span className="ml-1 text-ink-faint">private</span> : null}
                  </span>
                  <form action={linkRepositoryAction}>
                    <input type="hidden" name="externalId" value={r.externalId} />
                    {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
                    <button type="submit" className="font-medium text-brand hover:underline">
                      Link
                    </button>
                  </form>
                </li>
              ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            A repository belongs to one client at a time. Linking it here makes it readable in {owner}’s workspace only.
          </p>
        </div>
      </div>
    </details>
  );
}
