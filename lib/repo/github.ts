import "server-only";
import { createPrivateKey, createSign } from "node:crypto";
import { checkBranch, checkPath, isSearchable, isSecretPath, LIMITS, looksBinary } from "./policy";
import {
  RepoError,
  type ChangedFile,
  type CommitInfo,
  type FileSlice,
  type RepositoryReader,
  type SearchResult,
  type Snapshot,
  type TreeEntry,
} from "./types";

/**
 * GitHub, through a GitHub App — never a person's token.
 *
 * The app is installed with Contents: read and Metadata: read and nothing
 * else. On top of that, every installation token this code asks for is
 * narrowed AGAIN, at the moment it is minted, to the one repository being read
 * and to read-only permissions. So even a bug here that named the wrong
 * repository would be refused by GitHub, not merely by this file.
 *
 * Every read in a run resolves the branch to ONE commit first and reads that
 * commit's tree; files are fetched by blob id from that tree. A file therefore
 * cannot change between being listed and being read, and a symbolic link or
 * submodule is recognised by its mode and refused rather than followed.
 */

const API_VERSION = "2022-11-28";

/** GitHub's refusal of a token, kept apart so a revoked cached token can be replaced. */
class BadCredentials extends RepoError {}

type Fetch = typeof fetch;

/** How long the list of repositories the app can see is kept before GitHub is asked again. */
const ACCESSIBLE_TTL_MS = 2 * 60_000;

export type AccessibleRepository = {
  installationId: number;
  externalId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
};

export type GitHubAppConfig = {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  fetch?: Fetch;
};

export function githubAppConfigFromEnv(): GitHubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const raw = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !raw) return null;
  return { appId, privateKey: normalizePem(raw), apiUrl: process.env.GITHUB_API_URL?.trim() || undefined };
}

/**
 * The key as GitHub's .pem file had it, however it was pasted.
 *
 * A dashboard field mangles a multi-line value in several ways, and each one
 * makes the key unreadable: wrapped in quotes, newlines typed as a literal
 * "\n", Windows line endings, or the line breaks turned into spaces or lost.
 * The base64 between the BEGIN and END lines is the key; everything else is
 * layout, so it is rebuilt from that, 64 characters a line.
 */
export function normalizePem(raw: string): string {
  let s = raw.trim();
  if (s.length > 1 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0]) s = s.slice(1, -1).trim();
  s = s.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n?/g, "\n");
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(s);
  if (!m) return s;
  const body = m[2]!.replace(/\s+/g, "");
  return `-----BEGIN ${m[1]}-----\n${(body.match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${m[1]}-----\n`;
}

/**
 * Why a key cannot be used, in words that point at the fix and never repeat
 * any of the key: what kind of block it is and how long, nothing more.
 */
export function privateKeyProblem(pem: string): string | null {
  const begin = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(pem);
  if (!begin) return "there is no -----BEGIN line. Paste the whole .pem file, including its BEGIN and END lines.";
  const kind = begin[1]!;
  if (!kind.includes("PRIVATE KEY")) return `it is a ${kind.toLowerCase()}, not a private key. Use the .pem file GitHub downloaded.`;
  const end = new RegExp(`-----END ${kind}-----`).exec(pem);
  if (!end) return "the -----END line is missing, so the key was cut short. Paste the whole file again.";
  const body = pem.slice(begin.index + begin[0].length, end.index).replace(/\s+/g, "");
  if (/[^A-Za-z0-9+/=]/.test(body)) return "the text between BEGIN and END has characters a key never contains. Paste the file again, unchanged.";
  try {
    createPrivateKey(pem);
    return null;
  } catch {
    return `the ${body.length} characters between BEGIN and END do not decode to a key (a 2048-bit GitHub key is about 1,600). Part of it is missing or changed; generate a new key and paste the whole file.`;
  }
}

/** The app itself: signs its own JWT and mints narrowed installation tokens. */
export class GitHubApp {
  private readonly api: string;
  private readonly doFetch: Fetch;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly config: GitHubAppConfig) {
    this.api = (config.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.doFetch = config.fetch ?? fetch;
  }

  /** A ten-minute app JWT (RS256), as GitHub specifies; nine to allow for clock skew. */
  appJwt(now = Math.floor(Date.now() / 1000)): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: this.config.appId })}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(body).sign(this.config.privateKey, "base64url");
    } catch {
      const why = privateKeyProblem(this.config.privateKey) ?? "it could not be used to sign.";
      throw new RepoError(`GITHUB_APP_PRIVATE_KEY is not a valid private key: ${why}`);
    }
    return `${body}.${signature}`;
  }

  async request<T>(path: string, auth: string, init: RequestInit = {}): Promise<T> {
    const res = await this.doFetch(`${this.api}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        Authorization: `Bearer ${auth}`,
        "User-Agent": "10xid-portal",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (res.status === 404) throw new RepoError("GitHub says that does not exist, or the app cannot see it.");
    if (res.status === 401) {
      throw new BadCredentials("GitHub refused the app's credentials. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.");
    }
    if (res.status === 403 || res.status === 429) {
      throw new RepoError("GitHub refused or rate-limited the request. Try again in a minute.");
    }
    if (!res.ok) throw new RepoError(`GitHub returned an error (${res.status}).`);
    return (await res.json()) as T;
  }

  /** Who the app is, by its own credentials — the check that the key works. */
  async whoAmI(): Promise<{ slug: string; name: string }> {
    return this.request("/app", this.appJwt());
  }

  /**
   * Every repository any installation of the app can see — names only, for
   * linking.
   *
   * It is the same list for everyone (it is the app's, not a business's), and
   * asking GitHub for it took up to twenty seconds, so it is kept for
   * ACCESSIBLE_TTL_MS and shared: callers within that window, and callers
   * arriving while it is being fetched, get the same answer. The
   * installations are asked at once rather than one after another. `fresh`
   * skips the kept copy.
   */
  async listAccessibleRepositories({ fresh = false } = {}): Promise<AccessibleRepository[]> {
    const kept = this.accessible;
    if (!fresh && kept && kept.at + ACCESSIBLE_TTL_MS > Date.now()) return kept.list;
    const load = this.loadAccessible();
    this.accessible = { at: Date.now(), list: load };
    // A failure is not kept: the next caller asks GitHub again.
    load.catch(() => {
      if (this.accessible?.list === load) this.accessible = null;
    });
    return load;
  }

  /**
   * One repository the app can see, by GitHub's id: from the kept list, and if
   * it is not there (installed a moment ago), from GitHub afresh.
   */
  async findAccessibleRepository(externalId: number): Promise<AccessibleRepository | undefined> {
    const hit = (await this.listAccessibleRepositories()).find((r) => r.externalId === externalId);
    return hit ?? (await this.listAccessibleRepositories({ fresh: true })).find((r) => r.externalId === externalId);
  }

  private accessible: { at: number; list: Promise<AccessibleRepository[]> } | null = null;

  private async loadAccessible(): Promise<AccessibleRepository[]> {
    const installs = await this.request<{ id: number }[]>("/app/installations?per_page=100", this.appJwt());
    const pages = await Promise.all(
      installs.map((inst) =>
        this.withInstallationToken(inst.id, null, (token) =>
          this.request<{
            repositories: { id: number; name: string; owner: { login: string }; default_branch: string; private: boolean }[];
          }>("/installation/repositories?per_page=100", token),
        ).then((page) => ({ installationId: inst.id, page })),
      ),
    );
    return pages.flatMap(({ installationId, page }) =>
      page.repositories.map((r) => ({
        installationId,
        externalId: r.id,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch,
        private: r.private,
      })),
    );
  }

  /**
   * Run a request with a cached installation token. A token GitHub has since
   * revoked — the app reinstalled, its key rotated — is answered 401 while it
   * still looks unexpired here; it is dropped and replaced once, not reused
   * until it would have expired.
   */
  async withInstallationToken<T>(installationId: number, repositoryId: number | null, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.installationToken(installationId, repositoryId);
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof BadCredentials)) throw err;
      this.tokens.delete(`${installationId}:${repositoryId ?? "*"}`);
      return fn(await this.installationToken(installationId, repositoryId));
    }
  }

  /**
   * An installation token narrowed to ONE repository (by GitHub's numeric id)
   * and read-only contents and metadata, cached until a minute before expiry.
   * `null` narrows to permissions only — used solely to list for linking.
   */
  async installationToken(installationId: number, repositoryId: number | null): Promise<string> {
    const key = `${installationId}:${repositoryId ?? "*"}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const body: Record<string, unknown> = { permissions: { contents: "read", metadata: "read" } };
    if (repositoryId !== null) body.repository_ids = [repositoryId];
    const res = await this.request<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      this.appJwt(),
      { method: "POST", body: JSON.stringify(body) },
    );
    this.tokens.set(key, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }
}

type RawTreeEntry = { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };

/** Parsed trees by tree sha — a commit's tree never changes, so this never goes stale. */
const treeCache = new Map<string, { entries: RawTreeEntry[]; truncated: boolean }>();
const TREE_CACHE_MAX = 16;

/** One linked repository, read through the app. */
export class GitHubRepository implements RepositoryReader {
  readonly fullName: string;

  constructor(
    private readonly app: GitHubApp,
    private readonly repo: { installationId: number; externalId: number; owner: string; name: string; defaultBranch: string },
  ) {
    this.fullName = `${repo.owner}/${repo.name}`;
  }

  get defaultBranch() {
    return this.repo.defaultBranch;
  }

  private base() {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}`;
  }

  private async get<T>(path: string): Promise<T> {
    return this.app.withInstallationToken(this.repo.installationId, this.repo.externalId, (token) =>
      this.app.request<T>(`${this.base()}${path}`, token),
    );
  }

  async listBranches(): Promise<string[]> {
    const rows = await this.get<{ name: string }[]>("/branches?per_page=100");
    return rows.map((b) => b.name);
  }

  async snapshot(branch: string): Promise<Snapshot> {
    const b = checkBranch(branch);
    if (!b.ok) throw new RepoError(b.reason);
    const commit = await this.get<{ sha: string; commit: { tree: { sha: string } } }>(
      `/commits/${encodeURIComponent(b.branch)}`,
    );
    const tree = await this.tree(commit.commit.tree.sha);
    return { branch: b.branch, commitSha: commit.sha, treeSha: commit.commit.tree.sha, treeTruncated: tree.truncated };
  }

  private async tree(treeSha: string) {
    const key = `${this.repo.externalId}:${treeSha}`;
    const hit = treeCache.get(key);
    if (hit) return hit;
    const res = await this.get<{ tree: RawTreeEntry[]; truncated: boolean }>(`/git/trees/${treeSha}?recursive=1`);
    const value = { entries: res.tree, truncated: res.truncated };
    treeCache.set(key, value);
    if (treeCache.size > TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value!);
    return value;
  }

  private async entries(snap: Snapshot) {
    return (await this.tree(snap.treeSha)).entries;
  }

  async listDirectory(snap: Snapshot, path: string): Promise<TreeEntry[]> {
    const p = checkPath(path);
    // Listing a secret folder is refused like reading it.
    if (!p.ok) throw new RepoError(p.reason);
    const prefix = p.path ? `${p.path}/` : "";
    const all = await this.entries(snap);
    const out: TreeEntry[] = [];
    for (const e of all) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      if (!rest || rest.includes("/")) continue; // direct children only
      if (e.type === "commit") continue; // submodules: another repository
      if (e.mode === "120000") continue; // symbolic links: never offered
      out.push({
        path: e.path,
        type: e.type === "tree" ? "dir" : "file",
        size: e.size,
        secret: isSecretPath(e.path),
      });
      if (out.length >= LIMITS.maxTreeEntries) break;
    }
    return out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1));
  }

  async readFile(snap: Snapshot, path: string, range: { start?: number; end?: number; whole?: boolean } = {}): Promise<FileSlice> {
    const p = checkPath(path);
    if (!p.ok) throw new RepoError(p.reason);
    if (!p.path) throw new RepoError("Name a file to read.");
    const entry = (await this.entries(snap)).find((e) => e.path === p.path);
    if (!entry) throw new RepoError(`${p.path} does not exist on ${snap.branch}.`);
    if (entry.type === "tree") throw new RepoError(`${p.path} is a folder. List it instead.`);
    if (entry.type === "commit") throw new RepoError(`${p.path} is a submodule — another repository — and is not read.`);
    if (entry.mode === "120000") throw new RepoError(`${p.path} is a symbolic link and links are never followed.`);
    if ((entry.size ?? 0) > LIMITS.maxFileBytes) {
      throw new RepoError(`${p.path} is ${Math.round((entry.size ?? 0) / 1024)} KB, over the ${LIMITS.maxFileBytes / 1000} KB read limit.`);
    }
    const blob = await this.get<{ content: string; encoding: string }>(`/git/blobs/${entry.sha}`);
    const bytes = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8");
    if (looksBinary(bytes)) throw new RepoError(`${p.path} is a binary file and is not read as text.`);
    const lines = bytes.toString("utf8").split("\n");
    const start = range.whole ? 1 : Math.max(1, Math.floor(range.start ?? 1));
    const end = range.whole
      ? lines.length
      : Math.min(lines.length, Math.floor(range.end ?? start + LIMITS.maxLinesPerRead - 1), start + LIMITS.maxLinesPerRead - 1);
    return {
      path: p.path,
      blobSha: entry.sha,
      startLine: start,
      endLine: Math.max(start, end),
      totalLines: lines.length,
      text: lines.slice(start - 1, end).join("\n"),
    };
  }

  async search(snap: Snapshot, query: string, opts: { mode: "filename" | "text"; under?: string }): Promise<SearchResult> {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || q.length > 200) throw new RepoError("Search for between 2 and 200 characters.");
    let prefix = "";
    if (opts.under) {
      const p = checkPath(opts.under);
      if (!p.ok) throw new RepoError(p.reason);
      prefix = p.path ? `${p.path}/` : "";
    }
    const files = (await this.entries(snap)).filter(
      (e) => e.type === "blob" && e.mode !== "120000" && e.path.startsWith(prefix),
    );

    if (opts.mode === "filename") {
      const hits = files
        .filter((e) => e.path.toLowerCase().includes(q))
        .slice(0, LIMITS.maxSearchResults)
        .map((e) => ({ path: e.path }));
      return { hits, filesSearched: files.length, filesEligible: files.length, truncated: hits.length >= LIMITS.maxSearchResults };
    }

    // Text: only plausible text files, small ones, never secrets — and only so
    // many of them, so one question cannot walk a whole repository.
    const eligible = files.filter((e) => isSearchable(e.path, e.size));
    const batch = eligible.slice(0, LIMITS.maxSearchFiles);
    const hits: SearchResult["hits"] = [];
    let searched = 0;
    for (let i = 0; i < batch.length && hits.length < LIMITS.maxSearchResults; i += 6) {
      const chunk = batch.slice(i, i + 6);
      const blobs = await Promise.all(
        chunk.map((e) => this.get<{ content: string; encoding: string }>(`/git/blobs/${e.sha}`).catch(() => null)),
      );
      chunk.forEach((e, j) => {
        const blob = blobs[j];
        if (!blob) return;
        searched++;
        const bytes = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8");
        if (looksBinary(bytes)) return;
        const lines = bytes.toString("utf8").split("\n");
        for (let n = 0; n < lines.length && hits.length < LIMITS.maxSearchResults; n++) {
          if (lines[n]!.toLowerCase().includes(q)) {
            hits.push({ path: e.path, line: n + 1, preview: lines[n]!.trim().slice(0, 200) });
          }
        }
      });
    }
    return {
      hits,
      filesSearched: searched,
      filesEligible: eligible.length,
      truncated: eligible.length > batch.length || hits.length >= LIMITS.maxSearchResults,
    };
  }

  async commitHistory(snap: Snapshot, opts: { path?: string; limit?: number }): Promise<CommitInfo[]> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), LIMITS.maxCommits);
    let query = `?sha=${snap.commitSha}&per_page=${limit}`;
    if (opts.path) {
      const p = checkPath(opts.path);
      if (!p.ok) throw new RepoError(p.reason);
      if (p.path) query += `&path=${encodeURIComponent(p.path)}`;
    }
    const rows = await this.get<
      { sha: string; commit: { message: string; author: { name: string; date: string } | null } }[]
    >(`/commits${query}`);
    return rows.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0]!.slice(0, 200),
      author: c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? "",
    }));
  }

  async changedFiles(base: string, head: string): Promise<ChangedFile[]> {
    for (const b of [base, head]) {
      const ok = checkBranch(b);
      if (!ok.ok) throw new RepoError(ok.reason);
    }
    const res = await this.get<{ files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[] }>(
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    return (res.files ?? [])
      .slice(0, LIMITS.maxChangedFiles)
      .map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        // A secret file's diff is a secret too.
        patch: isSecretPath(f.filename) ? undefined : f.patch?.slice(0, 4000),
      }));
  }
}
