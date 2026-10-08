import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EVERY PROTECTED REQUEST PASSES THROUGH THE CENTRAL FUNCTION.
 *
 * Build brief, instruction 2: one central server-side authorization function
 * that every protected request passes through. A rule like that is only true
 * until the next page is added, so this reads the app from disk and fails when
 * a page, a route handler or a server action does not call one of the entry
 * points of lib/auth/authorize.ts — and when a form posting to a server action
 * does not carry the CSRF token.
 *
 * The exemptions are listed with their reasons, so adding one is a decision on
 * the record rather than an oversight.
 */

const ROOT = join(import.meta.dirname, "..");
const APP = join(ROOT, "app");

const GUARDS = [
  "requirePage(",
  "requireAction(",
  "authorizeRequest(",
  "requireStaffAccess(",
  "requireSameOriginRequest(",
  "requireSignedIn(",
  "requireSignedInAction(",
  "requireChatBossPage(",
  "requireChatBossAction(",
  "authorizeChatBossRequest(",
];

const EXEMPT: Record<string, string> = {
  "app/page.tsx": "Redirects to /dashboard; reads and grants nothing.",
  "app/auth/sso/start/route.ts": "Starts the handoff to the login host. No session yet; the return path stays in this host's cookie.",
  "app/auth/sso/callback/route.ts":
    "Ends the handoff: state cookie, single-use ticket for this host, live sign-in past the authenticator. Creates the session.",
  "app/auth/sso/failed/page.tsx": "One static message for every handoff failure. Reads nothing.",
  "app/healthz/route.ts": "Railway's healthcheck: answers 200 once startup has passed, and says nothing else.",
  "app/access/page.tsx": "Describes the person's own sign-in state after a refusal; shows no business data.",
  "app/api/v1/jobs/route.ts":
    "The machine endpoint: an API key, not a session, bound to one business and write-only. No keys can be minted while staff access is off.",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(APP).map((path) => ({
  path: relative(ROOT, path),
  source: readFileSync(path, "utf8"),
}));

const pages = files.filter((f) => /\/page\.tsx$/.test(f.path));
const routes = files.filter((f) => /\/route\.ts$/.test(f.path));
const actionFiles = files.filter((f) => /^\s*["']use server["']/.test(f.source));

/** Function name → its body, roughly: from its declaration to the next top-level declaration. */
function functions(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
  const starts = [...source.matchAll(re)];
  starts.forEach((match, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    out.set(match[1], source.slice(match.index, end));
  });
  return out;
}

const guarded = (text: string) => GUARDS.some((g) => text.includes(g));

describe("every page, route and server action is authorized", () => {
  test("the app has the surfaces this test expects to find", () => {
    expect(pages.length).toBeGreaterThan(5);
    expect(actionFiles.length).toBeGreaterThan(3);
  });

  test.each(pages.map((f) => [f.path, f.source]))("page %s", (path, source) => {
    if (EXEMPT[path]) return;
    expect(guarded(source), `${path} must call the central authorization function`).toBe(true);
  });

  test.each(routes.map((f) => [f.path, f.source]))("route %s", (path, source) => {
    if (EXEMPT[path]) return;
    for (const [name, body] of functions(source)) {
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(name)) continue;
      expect(guarded(body), `${path} ${name} must call the central authorization function`).toBe(true);
    }
  });

  test.each(actionFiles.map((f) => [f.path, f.source]))("server actions in %s", (path, source) => {
    const fns = functions(source);
    // A local helper that calls a guard counts, as does one that calls such a helper.
    const safe = new Set([...fns].filter(([, body]) => guarded(body)).map(([name]) => name));
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, body] of fns) {
        if (!safe.has(name) && [...safe].some((s) => body.includes(`${s}(`))) {
          safe.add(name);
          grew = true;
        }
      }
    }
    const exported = [...source.matchAll(/^export\s+async\s+function\s+(\w+)/gm)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(safe.has(name), `${path} ${name} must call the central authorization function`).toBe(true);
    }
  });

  test("the exemptions all still exist", () => {
    for (const path of Object.keys(EXEMPT)) {
      expect(files.some((f) => f.path === path), path).toBe(true);
    }
  });
});

describe("every form posting to a server action carries the CSRF token", () => {
  const withForms = files.filter((f) => f.path.endsWith(".tsx") && /<form\b[^>]*\baction=\{/.test(f.source));

  test.each(withForms.map((f) => [f.path, f.source]))("%s", (path, source) => {
    // Client components cannot render the server-side field. Chat Boss's are
    // the only ones, and they carry the token the page handed them instead
    // (app/chat/csrf.tsx).
    const client = /^\s*["']use client["']/.test(source);
    if (client) {
      expect(path.startsWith("app/chat/"), `${path}: a client-side form outside Chat Boss`).toBe(true);
    }
    const field = client ? "<CsrfInput />" : "<CsrfField />";
    const forms = [...source.matchAll(/<form\b[^>]*\baction=\{[\s\S]*?<\/form>/g)].map((m) => m[0]);
    for (const form of forms) {
      expect(form.includes(field), `${path}: ${form.slice(0, 80)}…`).toBe(true);
    }
  });
});
