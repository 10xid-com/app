import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * What proxy.ts does with a request before any page sees it.
 *
 * Routing and the cheap half of the request checks only — nothing here is a
 * permission. Every branch that does not need a live WorkOS session is pinned
 * down; the signed-in branch needs WorkOS's signing keys and is covered by the
 * staging session test instead.
 *
 * The SDK reads its configuration when it is imported, so each test imports
 * the proxy afresh after setting the environment.
 */

const APP = "app.10xid.com";
const ORIGIN = `https://${APP}`;

async function loadProxy() {
  vi.resetModules();
  return (await import("@/proxy")).default;
}

/**
 * As the server sees it behind Railway's proxy: plain http to the address the
 * process is bound to, with the public host in the Host header. A page
 * navigation carries the headers a browser sends for one.
 */
function request(
  host: string,
  path: string,
  init: { method?: string; origin?: string; page?: boolean } = {},
) {
  return new NextRequest(`http://localhost:8080${path}`, {
    method: init.method ?? "GET",
    headers: {
      host,
      ...(init.origin ? { origin: init.origin } : {}),
      ...(init.page ? { accept: "text/html", "sec-fetch-dest": "document" } : {}),
    },
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", `${ORIGIN}/callback`);
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  vi.stubEnv("WORKOS_API_KEY", "sk_test_proxy");
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "x".repeat(40));
  vi.stubEnv("WORKOS_COOKIE_MAX_AGE", "604800");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("one host", () => {
  test("a client domain gets nothing from the portal", async () => {
    const proxy = await loadProxy();
    for (const host of ["northstar.10xconnections.com", "login.10xid.com", "evil.10xid.com"]) {
      const response = await proxy(request(host, "/dashboard"));
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  test("without a configured callback, nothing is served", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "");
    const proxy = await loadProxy();
    expect((await proxy(request(APP, "/dashboard"))).status).toBe(500);
  });
});

describe("state-changing requests", () => {
  test("refused unless the Origin is exactly the app's", async () => {
    const proxy = await loadProxy();
    for (const origin of [
      undefined,
      "null",
      "https://evil.10xid.com",
      "https://app.10xid.com.evil.test",
      "http://app.10xid.com",
    ]) {
      const response = await proxy(request(APP, "/jobs", { method: "POST", origin }));
      expect(response.status, String(origin)).toBe(403);
    }
  });

  test("from the app's own origin, they go on to the session check", async () => {
    const proxy = await loadProxy();
    // No session cookie, so the next refusal is "sign in first", not the origin.
    const response = await proxy(request(APP, "/jobs", { method: "POST", origin: ORIGIN }));
    expect(response.status).toBe(401);
  });
});

describe("signed out", () => {
  test("a page is sent to WorkOS, and comes back to the one callback", async () => {
    const proxy = await loadProxy();
    const response = await proxy(request(APP, "/jobs?x=1", { page: true }));
    const location = new URL(response.headers.get("location")!);
    expect(location.hostname).toBe("api.workos.com");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(location.searchParams.get("client_id")).toBe("client_test");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    // The PKCE verifier cookie travels with the redirect: host-only, Secure
    // even though the server itself was reached over http, HttpOnly.
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^wos-auth-verifier/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  test("the callback and sign-in routes are reachable", async () => {
    const proxy = await loadProxy();
    for (const path of ["/callback?code=c&state=s", "/sign-in"]) {
      const response = await proxy(request(APP, path));
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.status, path).toBe(200);
    }
  });

  test("a fetch is refused rather than answered with a sign-in page", async () => {
    const proxy = await loadProxy();
    expect((await proxy(request(APP, "/api/workspace/repositories"))).status).toBe(401);
  });
});

describe("the healthcheck", () => {
  test("answers on any host, so Railway's checker reaches it", async () => {
    const proxy = await loadProxy();
    const response = await proxy(request("healthcheck.railway.app", "/healthz"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("the machine endpoint", () => {
  test("carries an API key, not a cookie, and is let through untouched", async () => {
    const proxy = await loadProxy();
    const response = await proxy(
      request(APP, "/api/v1/jobs", { method: "POST", origin: "https://northstar.example" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
