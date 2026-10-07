import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { sealData } from "iron-session";
import { sessionConfigProblems } from "@/lib/auth/origin";

/**
 * THE SESSION COOKIE, AS THE SDK ACTUALLY WRITES IT.
 *
 * Build brief, instruction 4: prove the session cookie is set on the App host
 * only, with Secure, HttpOnly and Path=/, before anything is built on it. And
 * Revision 2: 604800 seconds, SameSite=Lax, the domain setting left unset.
 *
 * The SDK writes the cookie in two places, and both are driven here through
 * its real code, with only the network replaced:
 *
 *   the callback   PKCE checked, the code exchanged (WorkOS stubbed), the
 *                  session sealed and set through Next's cookie store;
 *   a refresh      the proxy finds an access token that no longer verifies
 *                  (WorkOS's key set stubbed), refreshes it (stubbed), and
 *                  writes the new session as a Set-Cookie header.
 *
 * Both requests arrive the way Railway delivers them: plain http to the bound
 * address, with the public host in the Host header. That is the case that
 * would silently drop Secure if the SDK were handed the raw request.
 *
 * The production check still stands: read the real Set-Cookie on staging and
 * production after a real sign-in (docs/session-gate.md). This proves the code
 * path; that proves the deployment.
 */

const APP = "app.10xid.com";
const ORIGIN = `https://${APP}`;
const PASSWORD = "p".repeat(40);

// Next's cookie store, standing in for a request scope: what the SDK sets is
// serialized exactly as Next would serialize it onto the response.
const jar = { cookies: new ResponseCookies(new Headers()) };
vi.mock("next/headers", () => ({
  cookies: async () => jar.cookies,
  headers: async () => new Headers({ host: APP }),
}));

// The key set: every access token is "no longer valid", which is what makes
// the proxy refresh. decodeJwt and the rest stay real.
vi.mock("jose", async (original) => ({
  ...(await original<typeof import("jose")>()),
  jwtVerify: vi.fn(async () => {
    throw new Error("expired");
  }),
}));

// The callback's onSuccess writes to the database; that is tested in
// sign-in.test.ts, not here.
vi.mock("@/lib/auth/sign-in", () => ({ resolveSignIn: vi.fn(async () => "bound") }));

function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`;
}

const user = {
  object: "user",
  id: "user_01TEST",
  email: "owner@example.com",
  emailVerified: true,
  firstName: null,
  lastName: null,
  profilePictureUrl: null,
  createdAt: "2026-10-07T00:00:00Z",
  updatedAt: "2026-10-07T00:00:00Z",
};

function tokens() {
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: unsignedJwt({ sub: user.id, sid: "session_01TEST", iat: now, exp: now + 300 }),
    refreshToken: "refresh_01TEST",
    user,
  };
}

/** One serialized Set-Cookie line, split into its attributes. */
function attributes(line: string) {
  const [pair, ...rest] = line.split(/;\s*/);
  const map = new Map(rest.map((a) => {
    const [k, ...v] = a.split("=");
    return [k.toLowerCase(), v.join("=")] as const;
  }));
  return { name: pair.split("=")[0], map };
}

function expectAgreedCookie(line: string) {
  const { name, map } = attributes(line);
  expect(name).toBe("wos-session");
  expect(map.has("secure"), "Secure").toBe(true);
  expect(map.has("httponly"), "HttpOnly").toBe(true);
  expect(map.get("path")).toBe("/");
  expect(map.has("domain"), "no Domain: host-only").toBe(false);
  expect(map.get("samesite")?.toLowerCase()).toBe("lax");
  expect(map.get("max-age")).toBe("604800");
}

beforeEach(() => {
  vi.resetModules();
  jar.cookies = new ResponseCookies(new Headers());
  vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", `${ORIGIN}/callback`);
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  vi.stubEnv("WORKOS_API_KEY", "sk_test_cookie");
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", PASSWORD);
  vi.stubEnv("WORKOS_COOKIE_MAX_AGE", "604800");
  vi.stubEnv("WORKOS_COOKIE_DOMAIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the session cookie", () => {
  test("from the callback: host-only, Secure, HttpOnly, Path=/, Lax, seven days", async () => {
    const proxy = (await import("@/proxy")).default;
    const { getWorkOS } = await import("@workos-inc/authkit-nextjs");
    const { GET } = await import("@/app/callback/route");

    // Start a sign-in the way a browser does, to get a real PKCE state and
    // its verifier cookie.
    const start = await proxy(
      new NextRequest("http://localhost:8080/dashboard", {
        headers: { host: APP, accept: "text/html", "sec-fetch-dest": "document" },
      }),
    );
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const verifier = start.headers.get("set-cookie")!.split(";")[0];

    vi.spyOn(getWorkOS().userManagement, "authenticateWithCode").mockResolvedValue(
      tokens() as never,
    );

    const response = await GET(
      new NextRequest(
        `http://localhost:8080/callback?code=code_01TEST&state=${encodeURIComponent(state)}`,
        { headers: { host: APP, cookie: verifier } },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    const line = jar.cookies.toString().split(/, (?=wos-session=)/).find((l) => l.startsWith("wos-session="));
    expect(line, "the callback set a session cookie").toBeDefined();
    expectAgreedCookie(line!);
  });

  test("from a refresh in the proxy: the same attributes", async () => {
    const proxy = (await import("@/proxy")).default;
    const { getWorkOS } = await import("@workos-inc/authkit-nextjs");
    vi.spyOn(getWorkOS().userManagement, "authenticateWithRefreshToken").mockResolvedValue(
      tokens() as never,
    );

    const sealed = await sealData(tokens(), { password: PASSWORD });
    const response = await proxy(
      new NextRequest("http://localhost:8080/dashboard", {
        headers: { host: APP, cookie: `wos-session=${sealed}` },
      }),
    );

    const lines = response.headers.getSetCookie();
    const line = lines.find((l) => l.startsWith("wos-session="));
    expect(line, "the refresh wrote a session cookie").toBeDefined();
    expectAgreedCookie(line!);
  });

  test("handed the raw request, the SDK would have dropped Secure", async () => {
    // Why addressedToApp exists, pinned: the same refresh, bypassing it.
    const { authkit, getWorkOS } = await import("@workos-inc/authkit-nextjs");
    vi.spyOn(getWorkOS().userManagement, "authenticateWithRefreshToken").mockResolvedValue(
      tokens() as never,
    );
    const sealed = await sealData(tokens(), { password: PASSWORD });
    const { headers } = await authkit(
      new NextRequest("http://localhost:8080/dashboard", {
        headers: { host: APP, cookie: `wos-session=${sealed}` },
      }),
    );
    const line = headers.getSetCookie().find((l) => l.startsWith("wos-session="))!;
    expect(attributes(line).map.has("secure")).toBe(false);
  });
});

describe("startup refuses settings other than Revision 2's", () => {
  const good = {
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${ORIGIN}/callback`,
    WORKOS_COOKIE_MAX_AGE: "604800",
    WORKOS_COOKIE_PASSWORD: PASSWORD,
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test",
  } as unknown as NodeJS.ProcessEnv;

  test("the agreed settings pass", () => {
    expect(sessionConfigProblems(good)).toEqual([]);
    expect(sessionConfigProblems({ ...good, WORKOS_COOKIE_SAMESITE: "Lax" })).toEqual([]);
  });

  test.each([
    [{ WORKOS_COOKIE_DOMAIN: "10xid.com" }, /WORKOS_COOKIE_DOMAIN/],
    [{ WORKOS_COOKIE_MAX_AGE: undefined }, /604800/],
    [{ WORKOS_COOKIE_MAX_AGE: "34560000" }, /604800/],
    [{ WORKOS_COOKIE_SAMESITE: "none" }, /lax/],
    [{ NEXT_PUBLIC_WORKOS_REDIRECT_URI: `http://${APP}/callback` }, /https/],
    [{ NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${ORIGIN}/auth/callback` }, /\/callback/],
    [{ WORKOS_COOKIE_PASSWORD: "short" }, /32/],
    [{ WORKOS_API_KEY: "" }, /WORKOS_API_KEY/],
  ])("%o is refused", (change, message) => {
    expect(sessionConfigProblems({ ...good, ...change }).join("; ")).toMatch(message);
  });
});
