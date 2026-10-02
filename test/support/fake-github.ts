import { createHash } from "node:crypto";

/**
 * A small, honest stand-in for the GitHub REST API — just the endpoints the
 * workspace uses — shared by the unit tests (as a `fetch`) and the browser
 * tests (behind an HTTP server, test/e2e/mock-github.ts).
 *
 * It behaves like GitHub where it matters for safety:
 *   - an installation token only opens the repositories it was minted for,
 *     and a request with any other token is answered 404, as GitHub does;
 *   - trees report symbolic links as mode 120000 and submodules as type
 *     "commit", so the adapter's refusals are exercised against the real shapes;
 *   - blobs come back base64-encoded.
 *
 * It does not verify the app JWT's signature: the tests prove the adapter
 * sends one, not that GitHub's crypto works.
 */

export type FakeFile = string | Buffer | { symlink: string } | { submodule: true };

export type FakeRepo = {
  id: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private?: boolean;
  branches: Record<string, Record<string, FakeFile>>;
};

export type TokenRequest = { installationId: number; body: { repository_ids?: number[]; permissions?: Record<string, string> } };

const sha = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");

export function createFakeGitHub(repos: FakeRepo[]) {
  const tokens = new Map<string, { installationId: number; repositoryIds: number[] | null }>();
  const tokenRequests: TokenRequest[] = [];
  const requests: string[] = [];
  let tokenCounter = 0;

  // Content-addressed store, like git: blobs and trees by id.
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, { path: string; mode: string; type: string; sha: string; size?: number }[]>();
  const commits = new Map<string, { repo: number; branch: string; tree: string; message: string }>();

  function snapshot(repo: FakeRepo, branch: string) {
    const files = repo.branches[branch]!;
    const entries: { path: string; mode: string; type: string; sha: string; size?: number }[] = [];
    const dirs = new Set<string>();
    for (const [path, file] of Object.entries(files)) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      if (typeof file === "object" && "symlink" in file) {
        const b = Buffer.from(file.symlink);
        blobs.set(sha(b), b);
        entries.push({ path, mode: "120000", type: "blob", sha: sha(b), size: b.length });
      } else if (typeof file === "object" && "submodule" in file) {
        entries.push({ path, mode: "160000", type: "commit", sha: sha(path) });
      } else {
        const b = Buffer.isBuffer(file) ? file : Buffer.from(file);
        blobs.set(sha(b), b);
        entries.push({ path, mode: "100644", type: "blob", sha: sha(b), size: b.length });
      }
    }
    for (const d of dirs) entries.push({ path: d, mode: "040000", type: "tree", sha: sha(`tree:${repo.id}:${branch}:${d}`) });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const treeSha = sha(`root:${repo.id}:${branch}:${JSON.stringify(entries)}`);
    trees.set(treeSha, entries);
    const commitSha = sha(`commit:${treeSha}`);
    commits.set(commitSha, { repo: repo.id, branch, tree: treeSha, message: `Update ${branch}` });
    return { commitSha, treeSha };
  }
  const heads = new Map<string, { commitSha: string; treeSha: string }>();
  for (const r of repos) for (const b of Object.keys(r.branches)) heads.set(`${r.id}:${b}`, snapshot(r, b));

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const notFound = () => json(404, { message: "Not Found" });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const bearer = auth.replace(/^Bearer /, "");
    const path = url.pathname;
    requests.push(`${method} ${path}${url.search}`);

    const isJwt = bearer.split(".").length === 3;

    if (path === "/app" && method === "GET") {
      return isJwt ? json(200, { slug: "10xid-workspace", name: "10XiD Workspace" }) : json(401, {});
    }
    if (path === "/app/installations" && method === "GET") {
      if (!isJwt) return json(401, {});
      return json(200, [...new Set(repos.map((r) => r.installationId))].map((id) => ({ id })));
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint && method === "POST") {
      if (!isJwt) return json(401, {});
      const installationId = Number(mint[1]);
      const body = JSON.parse(String(init?.body ?? "{}"));
      tokenRequests.push({ installationId, body });
      const token = `ghs_fake_${++tokenCounter}`;
      tokens.set(token, { installationId, repositoryIds: body.repository_ids ?? null });
      return json(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    const grant = tokens.get(bearer);
    if (!grant) return json(401, { message: "Bad credentials" });
    const visible = repos.filter(
      (r) => r.installationId === grant.installationId && (grant.repositoryIds === null || grant.repositoryIds.includes(r.id)),
    );

    if (path === "/installation/repositories") {
      return json(200, {
        repositories: visible.map((r) => ({
          id: r.id, name: r.name, owner: { login: r.owner }, default_branch: r.defaultBranch, private: r.private ?? true,
        })),
      });
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (!m) return notFound();
    const repo = visible.find((r) => r.owner === decodeURIComponent(m[1]!) && r.name === decodeURIComponent(m[2]!));
    if (!repo) return notFound(); // exactly what GitHub says for a repository the token cannot see
    const rest = m[3]!;

    if (rest === "/branches") return json(200, Object.keys(repo.branches).map((name) => ({ name })));

    const commit = /^\/commits\/(.+)$/.exec(rest);
    if (commit) {
      const ref = decodeURIComponent(commit[1]!);
      const head = heads.get(`${repo.id}:${ref}`) ?? (commits.get(ref)?.repo === repo.id ? { commitSha: ref, treeSha: commits.get(ref)!.tree } : null);
      if (!head) return json(422, { message: "No commit found" });
      return json(200, { sha: head.commitSha, commit: { tree: { sha: head.treeSha } } });
    }
    if (rest === "/commits") {
      const at = url.searchParams.get("sha") ?? "";
      const c = commits.get(at);
      if (!c || c.repo !== repo.id) return json(422, {});
      return json(200, [
        { sha: at, commit: { message: `${c.message}\n\nbody`, author: { name: "Fake Author", date: "2026-09-30T12:00:00Z" } } },
      ]);
    }
    const tree = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest);
    if (tree) {
      const entries = trees.get(tree[1]!);
      return entries ? json(200, { sha: tree[1], tree: entries, truncated: false }) : notFound();
    }
    const blob = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest);
    if (blob) {
      const b = blobs.get(blob[1]!);
      return b ? json(200, { sha: blob[1], content: b.toString("base64"), encoding: "base64", size: b.length }) : notFound();
    }
    const compare = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
    if (compare) {
      const baseRef = decodeURIComponent(compare[1]!);
      const headRef = decodeURIComponent(compare[2]!);
      const baseBranch = repo.branches[baseRef];
      const headBranch = repo.branches[headRef] ?? repo.branches[commits.get(headRef)?.branch ?? ""];
      if (!baseBranch || !headBranch) return notFound();
      const files = [];
      for (const p of new Set([...Object.keys(baseBranch), ...Object.keys(headBranch)])) {
        const a = baseBranch[p];
        const b = headBranch[p];
        if (a === b || (typeof a === "string" && a === b)) continue;
        files.push({
          filename: p,
          status: a === undefined ? "added" : b === undefined ? "removed" : "modified",
          additions: 1,
          deletions: a === undefined ? 0 : 1,
          patch: `@@ -1 +1 @@\n-${typeof a === "string" ? a.split("\n")[0] : ""}\n+${typeof b === "string" ? b.split("\n")[0] : ""}`,
        });
      }
      return json(200, { files });
    }
    return notFound();
  };

  return {
    fetch: fetchImpl as typeof fetch,
    /** GitHub revoking every token it has issued, as on a reinstall. */
    revokeTokens: () => tokens.clear(),
    tokenRequests,
    requests,
    head: (repoId: number, branch: string) => heads.get(`${repoId}:${branch}`)!,
  };
}

/** A repository with something of everything the policy has to handle. */
export function sampleRepo(over: Partial<FakeRepo> = {}): FakeRepo {
  return {
    id: 1001,
    installationId: 77,
    owner: "10xid-com",
    name: "storefront",
    defaultBranch: "main",
    branches: {
      main: {
        "README.md": "# Storefront\n\nThe Rotary storefront.\n",
        "src/app.ts": "export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n",
        "src/lib/price.ts": Array.from({ length: 600 }, (_, i) => `export const P${i + 1} = ${i + 1};`).join("\n"),
        ".env": "STRIPE_SECRET=sk_live_do_not_send\n",
        ".env.example": "STRIPE_SECRET=\n",
        "config/deploy.pem": "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n",
        "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]),
        "link-to-secrets": { symlink: "../../etc/passwd" },
        "vendor/shared": { submodule: true },
      },
      "feature/checkout": {
        "README.md": "# Storefront\n\nThe Rotary storefront.\n",
        "src/app.ts": "export function greet(name: string) {\n  return `Welcome, ${name}`;\n}\n",
        "src/checkout.ts": "export const checkout = () => 'paid';\n",
        "src/lib/price.ts": Array.from({ length: 600 }, (_, i) => `export const P${i + 1} = ${i + 1};`).join("\n"),
      },
    },
    ...over,
  };
}
