import "server-only";
import { getLinkedRepository, type RepositoryRow } from "@/lib/db/repositories";
import { readerFor as defaultReaderFor, type ReaderFactory } from "@/lib/repo";
import { RepoError } from "@/lib/repo/types";
import type { WorkspaceOwner } from "@/lib/db/workspace";
import type { BoundRepository } from "./repo-tools";
import { fullName } from "./repo-tools";

/**
 * A conversation's repository, resolved to one commit of its branch.
 *
 * The repository comes from the conversation row, which the database has
 * already tied to this client; the branch from the same row. Nothing a browser
 * or a model sends can name a different repository.
 */
export async function bindRepository(
  owner: WorkspaceOwner,
  conversation: { repositoryId: string | null; branch: string | null },
  readerFor: ReaderFactory = defaultReaderFor,
): Promise<{ bound: BoundRepository | null } | { error: string }> {
  if (!conversation.repositoryId) return { bound: null };
  const row: RepositoryRow | null = await getLinkedRepository(owner, conversation.repositoryId);
  if (!row) return { error: "This conversation's repository is no longer linked to the client. Pick another or none." };
  const reader = readerFor(row);
  if (!reader) return { error: "The GitHub App is not configured on this server, so the repository cannot be read." };
  try {
    const snap = await reader.snapshot(conversation.branch ?? row.defaultBranch);
    return { bound: { row, reader, snap } };
  } catch (err) {
    if (err instanceof RepoError) return { error: `Could not read ${fullName(row)}: ${err.message}` };
    console.error("[workspace] repository snapshot failed", err);
    return { error: `Could not reach ${fullName(row)}.` };
  }
}
