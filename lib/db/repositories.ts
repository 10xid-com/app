import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DatabaseError } from "pg";
import { inOwnerTransaction } from "./connection";
import { conversations, repositories } from "./schema";
import { uuidv7 } from "../ids";
import type { WorkspaceOwner } from "./workspace";

/**
 * Which repositories belong to the client in scope.
 *
 * Read and written through the owner transaction, so the database filters by
 * client underneath (0019). A repository id from another client's screen is
 * simply not there.
 */

export type RepositoryRow = typeof repositories.$inferSelect;

export async function listLinkedRepositories(owner: WorkspaceOwner): Promise<RepositoryRow[]> {
  return inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .select()
      .from(repositories)
      .where(isNull(repositories.unlinkedAt))
      .orderBy(asc(repositories.owner), asc(repositories.name)),
  );
}

export async function getLinkedRepository(owner: WorkspaceOwner, id: string): Promise<RepositoryRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, id), isNull(repositories.unlinkedAt)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Names for repositories past runs read — unlinked ones included, so an old
 * receipt still says which repository it was.
 */
export async function repositoryNamesByIds(owner: WorkspaceOwner, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .select({ id: repositories.id, owner: repositories.owner, name: repositories.name })
      .from(repositories)
      .where(inArray(repositories.id, unique)),
  );
  return new Map(rows.map((r) => [r.id, `${r.owner}/${r.name}`]));
}

export class AlreadyLinkedError extends Error {
  constructor() {
    super("That repository is already linked to a client. Unlink it there first.");
    this.name = "AlreadyLinkedError";
  }
}

/**
 * Link a repository the GitHub App can see to the client in scope. The caller
 * has already confirmed, with GitHub, that the installation can reach it.
 */
export async function linkRepository(
  owner: WorkspaceOwner,
  repo: { installationId: number; externalId: number; owner: string; name: string; defaultBranch: string },
): Promise<RepositoryRow> {
  try {
    return await inOwnerTransaction(owner.organizationId, owner.userId, async (tx) => {
      const [row] = await tx
        .insert(repositories)
        .values({
          id: uuidv7(),
          organizationId: owner.organizationId,
          installationId: repo.installationId,
          externalId: repo.externalId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          linkedBy: owner.userId,
        })
        .returning();
      return row!;
    });
  } catch (err) {
    // The unique index spans every client: another client holds it.
    const cause = err instanceof Error && "cause" in err ? (err as { cause: unknown }).cause : err;
    if (cause instanceof DatabaseError && cause.code === "23505") throw new AlreadyLinkedError();
    throw err;
  }
}

export async function unlinkRepository(owner: WorkspaceOwner, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .update(repositories)
      .set({ unlinkedAt: new Date() })
      .where(and(eq(repositories.id, id), isNull(repositories.unlinkedAt)))
      .returning({ id: repositories.id }),
  );
  return rows.length === 1;
}

/**
 * Point a conversation at a repository and branch, or at none. The database
 * refuses a repository that is not this client's (0019's composite key).
 */
export async function setConversationRepository(
  owner: WorkspaceOwner,
  conversationId: string,
  repositoryId: string | null,
  branch: string | null,
): Promise<boolean> {
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .update(conversations)
      .set({ repositoryId, branch: repositoryId ? branch : null, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId))
      .returning({ id: conversations.id }),
  );
  return rows.length === 1;
}
