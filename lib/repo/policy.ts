/**
 * What may be read from a repository, decided before anything is fetched.
 *
 * Every path the model or a person names passes through `checkPath` first.
 * Paths are compared as plain repository paths — there is no filesystem here,
 * the files come from GitHub's API at one commit — but the same attacks apply
 * and are refused the same way:
 *
 *   traversal          `..`, absolute paths, backslashes, NUL and control bytes
 *   secrets            .env files, keys, certificates, credential stores
 *   git internals      anything under .git/
 *   symbolic links     refused by mode when the tree is read (see github.ts),
 *                      never followed — a link to ../../etc/passwd is a link
 *   submodules         refused: another repository, with its own permissions
 *
 * The deny list errs towards refusing. A file wrongly refused costs a question;
 * a key wrongly sent to a model provider cannot be unsent.
 */

export const LIMITS = {
  /** Longest path accepted. */
  maxPathLength: 400,
  /** Largest file read at all, in bytes. */
  maxFileBytes: 400_000,
  /** Most lines returned by one read. */
  maxLinesPerRead: 400,
  /** Most entries one tree listing returns. */
  maxTreeEntries: 500,
  /** Most files a text search opens. */
  maxSearchFiles: 200,
  /** Largest file a text search opens, in bytes. */
  maxSearchFileBytes: 200_000,
  /** Most matches a search returns. */
  maxSearchResults: 50,
  /** Most commits a history returns. */
  maxCommits: 30,
  /** Most changed files a comparison returns. */
  maxChangedFiles: 100,
  /** Lines of a selected context file sent up front; the rest on request. */
  contextHeadLines: 120,
} as const;

/** Basenames that are secrets, credentials or keys whatever folder they are in. */
const SECRET_NAMES = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production …
  /^\.envrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^_netrc$/i,
  /^\.git-credentials$/i,
  /^\.dockercfg$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^.*\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk|kdbx|ovpn)$/i,
  /^service-account.*\.json$/i,
  /^.*-credentials\.json$/i,
  /^\.htpasswd$/i,
  /^terraform\.tfstate(\.backup)?$/i,
  /^.*\.tfvars$/i,
];

/** Templates of secret files, committed precisely because they hold none. */
const SHAREABLE_NAMES = /^\.env\.(example|sample|template|dist)$/i;

/** Folders whose whole content is off limits. */
const SECRET_DIRS = [/^\.git$/i, /^\.ssh$/i, /^\.aws$/i, /^\.gnupg$/i, /^\.docker$/i, /^\.kube$/i];

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Normalise and vet a repository path. "" means the repository root and is
 * allowed for listings. Returns the canonical form: no leading or trailing
 * slash, no empty or `.` segments.
 */
export function checkPath(input: unknown): PathCheck {
  if (typeof input !== "string") return { ok: false, reason: "A path must be text." };
  if (input.length > LIMITS.maxPathLength) return { ok: false, reason: "That path is too long." };
  if (/[\u0000-\u001f\u007f]/.test(input)) return { ok: false, reason: "That path contains control characters." };
  if (input.includes("\\")) return { ok: false, reason: "Use forward slashes in paths." };
  // A leading slash means "from the repository root" and is simply dropped
  // below; a drive letter means somebody thinks this is a computer.
  if (/^[a-z]:/i.test(input)) return { ok: false, reason: "Paths are inside the repository, not on a computer." };
  const segments = input.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return { ok: false, reason: "Paths cannot go above the repository root." };
  for (const s of segments) {
    if (SECRET_DIRS.some((r) => r.test(s))) return { ok: false, reason: `Files under ${s}/ are never read.` };
  }
  const base = segments.at(-1);
  if (base && !SHAREABLE_NAMES.test(base) && SECRET_NAMES.some((r) => r.test(base))) {
    return { ok: false, reason: `${base} looks like a secret or credential file, so it is never read or sent to a model.` };
  }
  return { ok: true, path: segments.join("/") };
}

/** True for a path the tree may SHOW but the model must never READ. */
export function isSecretPath(path: string): boolean {
  return !checkPath(path).ok && path.length > 0;
}

/** A crude but dependable binary test: a NUL byte in the first 8 KB. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Extensions worth opening for a text search. */
const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|css|scss|html|htm|astro|vue|svelte|py|rb|go|rs|java|kt|php|cs|sql|sh|yml|yaml|toml|ini|xml|svg|graphql|prisma|env\.example)$/i;

export function isSearchable(path: string, size: number | undefined): boolean {
  return TEXT_EXT.test(path) && (size ?? 0) <= LIMITS.maxSearchFileBytes && !isSecretPath(path);
}

/** Branch names as git allows them, minus anything that could be smuggled. */
export function checkBranch(input: unknown): { ok: true; branch: string } | { ok: false; reason: string } {
  if (typeof input !== "string" || input.length === 0 || input.length > 255) {
    return { ok: false, reason: "That is not a branch name." };
  }
  if (/\.\.|[\u0000- ~^:?*[\\\u007f]|^\/|\/$|\.lock$|@\{/.test(input)) {
    return { ok: false, reason: "That is not a valid branch name." };
  }
  return { ok: true, branch: input };
}
