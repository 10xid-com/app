import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

/**
 * Where proxy.ts sends a request.
 *
 * The rules are routing only — nothing here is a permission — but a mistake in
 * them is a redirect loop, or a sign-in form on a host that should never show
 * one, so every branch is pinned down.
 */

const LOGIN = "login.10xid.com";
const PORTAL = "app.10xid.com";
const CLIENT = "northstar.10xconnections.com";

function visit(host: string, path: string, opts: { session?: boolean } = {}) {
  const request = new NextRequest(`https://${host}${path}`, {
    headers: {
      host,
      ...(opts.session ? { cookie: "__Host-portal_session=opaque" } : {}),
    },
  });
  return proxy(request);
}

/** The redirect target, or null when the request is let through. */
function target(response: Response): string | null {
  return response.headers.get("location");
}

beforeEach(() => {
  vi.stubEnv("PRIMARY_HOST", LOGIN);
  vi.stubEnv("SESSION_COOKIE_SECURE", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the portal", () => {
  test("with a cookie, a page is served", () => {
    expect(target(visit(PORTAL, "/dashboard", { session: true }))).toBeNull();
    expect(target(visit(CLIENT, "/jobs", { session: true }))).toBeNull();
  });

  test("with no cookie, any host starts the handoff and keeps the path", () => {
    expect(target(visit(PORTAL, "/jobs?x=1"))).toBe(
      `https://${PORTAL}/auth/sso/start?path=%2Fjobs%3Fx%3D1`,
    );
    expect(target(visit(CLIENT, "/"))).toBe(
      `https://${CLIENT}/auth/sso/start?path=%2F`,
    );
  });

  test("the handoff's own steps are left alone", () => {
    expect(target(visit(PORTAL, "/auth/sso/start?path=%2F"))).toBeNull();
    expect(target(visit(PORTAL, "/auth/sso/callback?ticket=t&state=s"))).toBeNull();
    expect(target(visit(PORTAL, "/auth/sso/failed"))).toBeNull();
  });

  test("every other /auth/ page is the login host's", () => {
    // Signing out lands on /auth/login; this app has no such page.
    expect(target(visit(PORTAL, "/auth/login"))).toBe(`https://${LOGIN}/auth/login`);
    expect(target(visit(CLIENT, "/auth/signup?next=%2F"))).toBe(
      `https://${LOGIN}/auth/signup?next=%2F`,
    );
    expect(target(visit(PORTAL, "/auth/2fa", { session: true }))).toBe(
      `https://${LOGIN}/auth/2fa`,
    );
  });

  test("machine endpoints answer without a redirect, cookie or not", () => {
    expect(target(visit(PORTAL, "/api/v1/jobs"))).toBeNull();
    expect(target(visit(CLIENT, "/api/workspace/repositories"))).toBeNull();
  });
});
