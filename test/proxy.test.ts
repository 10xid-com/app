import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import proxy from "@/proxy";

/**
 * What proxy.ts does with a request before any page sees it.
 *
 * Routing and the cheap half of the request checks only — nothing here is a
 * permission. Whether a session cookie is valid, and whether the sign-in
 * behind it still is, is lib/auth/session.ts's job (test/portal-session.test.ts).
 */

const APP = "app.10xid.com";
const ORIGIN = `https://${APP}`;

/**
 * As the server sees it behind Railway's proxy: plain http to the address the
 * process is bound to, with the public host in the Host header.
 */
function request(
  host: string,
  path: string,
  init: { method?: string; origin?: string; cookie?: string } = {},
) {
  return new NextRequest(`http://localhost:8080${path}`, {
    method: init.method ?? "GET",
    headers: {
      host,
      ...(init.origin ? { origin: init.origin } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
  });
}

const SESSION = "__Host-portal_session=opaque";
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  vi.stubEnv("PORTAL_HOST", APP);
  vi.stubEnv("PRIMARY_HOST", "login.10xid.com");
  vi.stubEnv("SESSION_COOKIE_SECURE", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("one host", () => {
  test("any other host gets nothing from the portal, the login host included", async () => {
    for (const host of ["northstar.10xconnections.com", "login.10xid.com", "evil.10xid.com"]) {
      const response = await proxy(request(host, "/dashboard", { cookie: SESSION }));
      expect(response.status, host).toBe(404);
    }
  });

  test("without PORTAL_HOST, nothing is served", async () => {
    vi.stubEnv("PORTAL_HOST", "");
    expect((await proxy(request(APP, "/dashboard"))).status).toBe(500);
  });
});

describe("state-changing requests", () => {
  test("refused unless the Origin is exactly the app's", async () => {
    for (const origin of [undefined, "null", "https://login.10xid.com", "https://evil.10xid.com", `${ORIGIN}.evil.test`]) {
      const response = await proxy(request(APP, "/jobs", { method: "POST", origin, cookie: SESSION }));
      expect(response.status, String(origin)).toBe(403);
    }
  });

  test("from the app's own origin, they go on", async () => {
    expect(passed(await proxy(request(APP, "/jobs", { method: "POST", origin: ORIGIN, cookie: SESSION })))).toBe(true);
  });
});

describe("no session cookie", () => {
  test("a page goes into the handoff, keeping the path on this host", async () => {
    const response = await proxy(request(APP, "/jobs/123?tab=files"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/sso/start?path=%2Fjobs%2F123%3Ftab%3Dfiles`);
  });

  test("the handoff's own routes are reachable", async () => {
    for (const path of ["/auth/sso/start?path=%2F", "/auth/sso/callback?ticket=x&state=y", "/auth/sso/failed"]) {
      expect(passed(await proxy(request(APP, path))), path).toBe(true);
    }
  });

  test("a fetch or a form post is refused rather than answered with a page", async () => {
    expect((await proxy(request(APP, "/api/workspace/repositories"))).status).toBe(401);
    expect((await proxy(request(APP, "/jobs", { method: "POST", origin: ORIGIN }))).status).toBe(401);
  });

  test("a legacy WorkOS cookie is not a session", async () => {
    const response = await proxy(request(APP, "/dashboard", { cookie: "wos-session=sealed" }));
    expect(response.headers.get("location")).toContain("/auth/sso/start");
  });
});

describe("the healthcheck", () => {
  test("answers on any host, so Railway's checker reaches it", async () => {
    for (const host of [APP, "localhost:8080", "10.0.0.7:8080"]) {
      expect(passed(await proxy(request(host, "/healthz"))), host).toBe(true);
    }
  });
});

describe("the machine endpoint", () => {
  test("carries an API key, not a cookie, and is let through untouched", async () => {
    const response = await proxy(request(APP, "/api/v1/jobs", { method: "POST", origin: "https://client.example" }));
    expect(passed(response)).toBe(true);
  });
});
