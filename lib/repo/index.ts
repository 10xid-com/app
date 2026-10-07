import "server-only";
import type { RepositoryRow } from "@/lib/db/repositories";
import { GitHubApp, GitHubRepository, githubAppConfigFromEnv } from "./github";
import type { RepositoryReader } from "./types";

/**
 * Where the rest of the app gets a repository reader from. One app instance
 * per process, so installation tokens are reused until they expire.
 */

let app: GitHubApp | null | undefined;

export function githubApp(): GitHubApp | null {
  if (app === undefined) {
    const config = githubAppConfigFromEnv();
    app = config ? new GitHubApp(config) : null;
  }
  return app;
}

export function githubConfigured(): boolean {
  return githubApp() !== null;
}

export type ReaderFactory = (row: RepositoryRow) => RepositoryReader | null;

/** A reader for a linked repository, or null when the GitHub App is not configured. */
export const readerFor: ReaderFactory = (row) => {
  const a = githubApp();
  if (!a) return null;
  return new GitHubRepository(a, {
    installationId: Number(row.installationId),
    externalId: Number(row.externalId),
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
  });
};
