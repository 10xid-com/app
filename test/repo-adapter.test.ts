import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { GitHubApp, GitHubRepository, githubAppConfigFromEnv, normalizePem } from "@/lib/repo/github";
import { applyEdit, unifiedDiff } from "@/lib/repo/patch";
import { checkBranch, checkPath, isSecretPath, LIMITS, looksBinary } from "@/lib/repo/policy";
import { RepoError } from "@/lib/repo/types";
import { parseMentions } from "@/lib/workspace/mentions";
import { createFakeGitHub, sampleRepo } from "./support/fake-github";

/**
 * The repository layer without a database: the path policy, the GitHub App
 * adapter against a GitHub stand-in, patch previews and @mentions.
 *
 * The adapter tests go through the real code path — JWT, narrowed token,
 * commit, tree, blob — with only the network replaced.
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function setup(repos = [sampleRepo()]) {
  const fake = createFakeGitHub(repos);
  const app = new GitHubApp({ appId: "5156600", privateKey, fetch: fake.fetch, apiUrl: "https://api.github.test" });
  const r = repos[0]!;
  const repo = new GitHubRepository(app, {
    installationId: r.installationId,
    externalId: r.id,
    owner: r.owner,
    name: r.name,
    defaultBranch: r.defaultBranch,
  });
  return { fake, app, repo };
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RepoError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("path policy", () => {
  test.each([
    ["../etc/passwd", /above the repository root/],
    ["src/../../x", /above the repository root/],
    ["C:/Windows/system32", /not on a computer/],
    ["src\\app.ts", /forward slashes/],
    ["src/\u0000app.ts", /control characters/],
    [".env", /secret/],
    ["config/.env.production", /secret/],
    ["deploy/server.pem", /secret/],
    ["home/.ssh/config", /never read/],
    [".git/config", /never read/],
    ["infra/prod.tfvars", /secret/],
    ["keys/id_ed25519", /secret/],
    ["x".repeat(LIMITS.maxPathLength + 1), /too long/],
  ])("refuses %s", (input, reason) => {
    const r = checkPath(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  test("normalises harmless forms and allows shareable templates", () => {
    expect(checkPath("/src//./app.ts/")).toEqual({ ok: true, path: "src/app.ts" });
    expect(checkPath("")).toEqual({ ok: true, path: "" });
    expect(checkPath(".env.example")).toEqual({ ok: true, path: ".env.example" });
    expect(isSecretPath(".env.example")).toBe(false);
    expect(isSecretPath("a/b/credentials.json")).toBe(true);
  });

  test("binary detection and branch names", () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
    expect(checkBranch("feature/checkout").ok).toBe(true);
    for (const bad of ["a..b", "has space", "x~1", "-", "@{-1}", "a:b", "/lead", "end/", "x.lock", ""]) {
      expect(checkBranch(bad).ok, bad).toBe(bad === "-");
    }
  });
});

describe("GitHub App adapter", () => {
  test("every installation token is narrowed to one repository and read-only permissions", async () => {
    const { fake, repo } = setup();
    const snap = await repo.snapshot("main");
    await repo.readFile(snap, "README.md");
    expect(fake.tokenRequests.length).toBeGreaterThan(0);
    for (const t of fake.tokenRequests) {
      expect(t.body.repository_ids).toEqual([1001]);
      expect(t.body.permissions).toEqual({ contents: "read", metadata: "read" });
    }
    // Reused until it expires, not minted per request.
    expect(fake.tokenRequests).toHaveLength(1);
  });

  test("a token GitHub has revoked is replaced once, not reused until it expires", async () => {
    const { fake, repo } = setup();
    await repo.listBranches();
    fake.revokeTokens();
    expect(await repo.listBranches()).toEqual(["main", "feature/checkout"]);
    expect(fake.tokenRequests).toHaveLength(2);
  });

  test("a token for one repository cannot read another, even by name", async () => {
    const other = sampleRepo({ id: 2002, name: "northstar-site" });
    const fake = createFakeGitHub([sampleRepo(), other]);
    const app = new GitHubApp({ appId: "1", privateKey, fetch: fake.fetch, apiUrl: "https://api.github.test" });
    // An adapter bound to repository 1001's id, but pointed at 2002's name:
    // GitHub refuses it because the token only opens 1001.
    const confused = new GitHubRepository(app, {
      installationId: 77, externalId: 1001, owner: "10xid-com", name: "northstar-site", defaultBranch: "main",
    });
    expect(await refused(confused.snapshot("main"))).toMatch(/does not exist, or the app cannot see it/);
  });

  test("snapshot pins a commit; reads return numbered slices with the blob id", async () => {
    const { fake, repo } = setup();
    const snap = await repo.snapshot("main");
    expect(snap.commitSha).toBe(fake.head(1001, "main").commitSha);
    const slice = await repo.readFile(snap, "src/lib/price.ts");
    expect(slice.startLine).toBe(1);
    expect(slice.endLine).toBe(LIMITS.maxLinesPerRead);
    expect(slice.totalLines).toBe(600);
    expect(slice.blobSha).toMatch(/^[0-9a-f]{40}$/);
    const tail = await repo.readFile(snap, "src/lib/price.ts", { start: 590, end: 2000 });
    expect([tail.startLine, tail.endLine]).toEqual([590, 600]);
    expect(tail.text.split("\n")[0]).toBe("export const P590 = 590;");
  });

  test("secrets, symbolic links, submodules, binaries and traversal are refused", async () => {
    const { repo } = setup();
    const snap = await repo.snapshot("main");
    expect(await refused(repo.readFile(snap, ".env"))).toMatch(/secret/);
    expect(await refused(repo.readFile(snap, "config/deploy.pem"))).toMatch(/secret/);
    expect(await refused(repo.readFile(snap, "link-to-secrets"))).toMatch(/symbolic link/);
    expect(await refused(repo.readFile(snap, "vendor/shared"))).toMatch(/submodule/);
    expect(await refused(repo.readFile(snap, "assets/logo.png"))).toMatch(/binary/);
    expect(await refused(repo.readFile(snap, "../../etc/passwd"))).toMatch(/above the repository root/);
    expect(await refused(repo.readFile(snap, "src"))).toMatch(/folder/);
    expect(await refused(repo.readFile(snap, "nope.ts"))).toMatch(/does not exist/);
    expect((await repo.readFile(snap, ".env.example")).text).toBe("STRIPE_SECRET=\n");
  });

  test("listings show secrets as unreadable and hide links and submodules", async () => {
    const { repo } = setup();
    const snap = await repo.snapshot("main");
    const root = await repo.listDirectory(snap, "");
    const names = root.map((e) => e.path);
    expect(names).toContain(".env");
    expect(root.find((e) => e.path === ".env")!.secret).toBe(true);
    expect(root.find((e) => e.path === "src")!.type).toBe("dir");
    expect(names).not.toContain("link-to-secrets");
    expect((await repo.listDirectory(snap, "vendor")).map((e) => e.path)).toEqual([]);
    expect(await refused(repo.listDirectory(snap, ".git"))).toMatch(/never read/);
  });

  test("search finds names and text, never inside secrets", async () => {
    const { repo } = setup();
    const snap = await repo.snapshot("main");
    const byName = await repo.search(snap, "app", { mode: "filename" });
    expect(byName.hits.map((h) => h.path)).toEqual(["src/app.ts"]);
    const byText = await repo.search(snap, "hello", { mode: "text" });
    expect(byText.hits).toEqual([{ path: "src/app.ts", line: 2, preview: "return `Hello, ${name}`;" }]);
    const secret = await repo.search(snap, "sk_live", { mode: "text" });
    expect(secret.hits).toEqual([]);
    expect(await refused(repo.search(snap, "x", { mode: "text" }))).toMatch(/between 2 and 200/);
  });

  test("branches, history and changed files", async () => {
    const { fake, repo } = setup();
    expect(await repo.listBranches()).toEqual(["main", "feature/checkout"]);
    const snap = await repo.snapshot("feature/checkout");
    const history = await repo.commitHistory(snap, { limit: 5 });
    expect(history[0]).toMatchObject({ sha: fake.head(1001, "feature/checkout").commitSha, message: "Update feature/checkout" });
    const changed = await repo.changedFiles("main", snap.commitSha);
    const byPath = Object.fromEntries(changed.map((f) => [f.path, f]));
    expect(byPath["src/checkout.ts"]!.status).toBe("added");
    expect(byPath["src/app.ts"]!.status).toBe("modified");
    // A secret file's diff is withheld even when only its name is shown.
    expect(byPath[".env"]!.status).toBe("removed");
    expect(byPath[".env"]!.patch).toBeUndefined();
  });

  test("the app signs a JWT GitHub accepts the shape of, and a broken key says so", async () => {
    const { app } = setup();
    const [h, p] = app.appJwt(1_800_000_000).split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "5156600" });
    expect(await app.whoAmI()).toMatchObject({ slug: "10xid-workspace" });
    const broken = new GitHubApp({ appId: "1", privateKey: "not a key" });
    expect(() => broken.appJwt()).toThrow(/not a valid private key/);
  });

  test("a key survives however it was pasted into a dashboard", () => {
    // GitHub's own download is PKCS#1 ("BEGIN RSA PRIVATE KEY"); test that shape too.
    const pkcs1 = createPrivateKey(privateKey).export({ type: "pkcs1", format: "pem" }).toString();
    for (const pem of [privateKey, pkcs1]) {
      const body = pem.trim();
      const pasted = [
        body, // as downloaded
        `"${body}"`, // wrapped in quotes
        body.replace(/\n/g, "\\n"), // newlines typed as a literal \n
        body.replace(/\n/g, "\r\n"), // Windows line endings
        body.replace(/\n/g, " "), // line breaks turned into spaces
        body.replace(/-----\n/g, "-----").replace(/\n(?!-----)/g, ""), // line breaks lost
      ];
      for (const raw of pasted) {
        const app = new GitHubApp({ appId: "1", privateKey: normalizePem(raw) });
        expect(() => app.appJwt(), raw.slice(0, 40)).not.toThrow();
      }
    }
  });

  test("a key that cannot work says why, without repeating any of it", () => {
    const pkcs1 = createPrivateKey(privateKey).export({ type: "pkcs1", format: "pem" }).toString();
    const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    const [head, ...rest] = pkcs1.trim().split("\n");
    const truncated = [head, ...rest.slice(0, 5), rest.at(-1)].join("\n");
    const cases: [string, RegExp][] = [
      ["Iv23liSomeClientSecretValue1234", /no -----BEGIN line/],
      [publicPem, /public key, not a private key/],
      [pkcs1.trim().split("\n").slice(0, -1).join("\n"), /END line is missing/],
      [pkcs1.replace(/\n([A-Za-z0-9+/]{10})/, "\n$1!!"), /characters a key never contains/],
      [truncated, /do not decode to a key/],
    ];
    for (const [raw, why] of cases) {
      const app = new GitHubApp({ appId: "1", privateKey: normalizePem(raw) });
      let message = "";
      try {
        app.appJwt();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/^GITHUB_APP_PRIVATE_KEY is not a valid private key: /);
      expect(message).toMatch(why);
      // Nothing of the key's body is ever in the message.
      const body = raw.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
      if (body.length > 12) expect(message).not.toContain(body.slice(0, 12));
    }
  });

  test("a key pasted on one line is restored", () => {
    const old = { ...process.env };
    process.env.GITHUB_APP_ID = "5156600";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
    try {
      expect(githubAppConfigFromEnv()!.privateKey.trim()).toBe(privateKey.trim());
    } finally {
      process.env = old;
    }
  });
});

describe("patch previews", () => {
  test("a replacement must match exactly once", () => {
    expect(applyEdit("a\nb\nc\n", { kind: "replace", replacements: [{ find: "b", replace: "B" }] })).toBe("a\nB\nc\n");
    expect(() => applyEdit("x x", { kind: "replace", replacements: [{ find: "x", replace: "y" }] })).toThrow(/more than once/);
    expect(() => applyEdit("abc", { kind: "replace", replacements: [{ find: "z", replace: "y" }] })).toThrow(/not in the file/);
    expect(() => applyEdit("abc", { kind: "create", content: "new" })).toThrow(/already exists/);
  });

  test("diffs look like git's", () => {
    const patch = unifiedDiff("src/app.ts", "one\ntwo\n", "one\n2\n");
    expect(patch).toMatch(/^--- a\/src\/app\.ts/);
    expect(patch).toContain("+++ b/src/app.ts");
    expect(patch).toContain("-two\n+2");
    expect(unifiedDiff("new.ts", null, "hi\n")).toMatch(/^--- \/dev\/null/);
  });
});

describe("@mentions", () => {
  test("files and folders, never emails or people", () => {
    expect(parseMentions("look at @src/app.ts and @folder:src/lib, thanks")).toEqual([
      { kind: "file", path: "src/app.ts" },
      { kind: "folder", path: "src/lib" },
    ]);
    expect(parseMentions("mail paolo@example.com or ask @alex")).toEqual([]);
    expect(parseMentions("@README.md.")).toEqual([{ kind: "file", path: "README.md" }]);
  });
});

describe("the list of repositories the app can see", () => {
  // A hand-rolled GitHub with two installations, counting what is asked of it.
  function github() {
    const asked: string[] = [];
    let repos = [{ id: 11, name: "site", owner: { login: "acme" }, default_branch: "main", private: true }];
    let failNext = false;
    const fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      asked.push(path);
      if (failNext) {
        failNext = false;
        return new Response("{}", { status: 500 });
      }
      if (path === "/app/installations") return Response.json([{ id: 1 }, { id: 2 }]);
      if (path.endsWith("/access_tokens")) return Response.json({ token: `t${path}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (path === "/installation/repositories") return Response.json({ repositories: repos });
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const app = new GitHubApp({ appId: "1", privateKey, fetch, apiUrl: "https://api.github.test" });
    return {
      app,
      asked,
      lists: () => asked.filter((p) => p === "/app/installations").length,
      add: (r: (typeof repos)[number]) => (repos = [...repos, r]),
      failOnce: () => (failNext = true),
    };
  }

  test("every installation is listed, and the answer is kept and shared", async () => {
    const g = github();
    const [a, b] = await Promise.all([g.app.listAccessibleRepositories(), g.app.listAccessibleRepositories()]);
    expect(a.map((r) => r.installationId).sort()).toEqual([1, 2]);
    expect(b).toBe(a);
    await g.app.listAccessibleRepositories();
    expect(g.lists()).toBe(1);
    await g.app.listAccessibleRepositories({ fresh: true });
    expect(g.lists()).toBe(2);
  });

  test("a failure is not kept", async () => {
    const g = github();
    g.failOnce();
    await expect(g.app.listAccessibleRepositories()).rejects.toBeInstanceOf(RepoError);
    expect(await g.app.listAccessibleRepositories()).toHaveLength(2);
  });

  test("finding one repository asks GitHub again when the kept list does not have it", async () => {
    const g = github();
    await g.app.listAccessibleRepositories();
    g.add({ id: 12, name: "new", owner: { login: "acme" }, default_branch: "main", private: false });
    expect((await g.app.findAccessibleRepository(11))?.name).toBe("site");
    expect(g.lists()).toBe(1);
    expect((await g.app.findAccessibleRepository(12))?.name).toBe("new");
    expect(g.lists()).toBe(2);
    expect(await g.app.findAccessibleRepository(99)).toBeUndefined();
  });
});
