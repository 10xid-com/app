/**
 * The repository layer's shapes, independent of GitHub.
 *
 * A future provider (or the signed local bridge) implements RepositoryReader;
 * nothing above this layer knows which one it is talking to.
 */

export type TreeEntry = {
  path: string;
  type: "file" | "dir";
  size?: number;
  /** Shown in the tree, never readable: secrets, keys, credential files. */
  secret: boolean;
};

export type FileSlice = {
  path: string;
  /** The blob's id at the commit read — what the receipt records. */
  blobSha: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
};

export type SearchHit = { path: string; line?: number; preview?: string };

export type SearchResult = {
  hits: SearchHit[];
  /** How much was looked at, so a partial search says it was partial. */
  filesSearched: number;
  filesEligible: number;
  truncated: boolean;
};

export type CommitInfo = { sha: string; message: string; author: string; date: string };

export type ChangedFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type Snapshot = {
  /** The branch asked for. */
  branch: string;
  /** The commit it resolved to; every read in a run uses this one. */
  commitSha: string;
  /** That commit's root tree, which every listing and read walks. */
  treeSha: string;
  treeTruncated: boolean;
};

export interface RepositoryReader {
  readonly fullName: string;
  readonly defaultBranch: string;
  listBranches(): Promise<string[]>;
  snapshot(branch: string): Promise<Snapshot>;
  listDirectory(snap: Snapshot, path: string): Promise<TreeEntry[]>;
  /** `whole` lifts the per-read line cap (not the size cap); server-side use only. */
  readFile(snap: Snapshot, path: string, range?: { start?: number; end?: number; whole?: boolean }): Promise<FileSlice>;
  search(snap: Snapshot, query: string, opts: { mode: "filename" | "text"; under?: string }): Promise<SearchResult>;
  commitHistory(snap: Snapshot, opts: { path?: string; limit?: number }): Promise<CommitInfo[]>;
  changedFiles(base: string, head: string): Promise<ChangedFile[]>;
}

/** A refusal or failure the person and the model should see in words. */
export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}
