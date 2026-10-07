import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * signInUrl() reads PRIMARY_HOST when the module loads, as the rest of
 * lib/auth/sso does, so each case loads it fresh.
 */
async function load(primary: string) {
  vi.resetModules();
  vi.stubEnv("PRIMARY_HOST", primary);
  vi.stubEnv("SESSION_COOKIE_SECURE", "true");
  return import("@/lib/auth/sso");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signInUrl", () => {
  test("is the login host's form by full address", async () => {
    const sso = await load("login.10xid.com");
    expect(sso.signInUrl()).toBe("https://login.10xid.com/auth/login");
  });

  test("is a plain path when there is no login host configured", async () => {
    const sso = await load("");
    expect(sso.signInUrl()).toBe("/auth/login");
  });
});
