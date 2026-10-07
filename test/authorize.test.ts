import { describe, expect, test, vi } from "vitest";
import {
  authorize,
  STAFF_ACCESS,
  type AuthorizationDeps,
  type AuthorizationRequest,
} from "@/lib/auth/authorize";
import type { Identity, SessionContext } from "@/lib/auth/session";
import { csrfTokenFor, isValidCsrfToken } from "@/lib/auth/csrf";
import { isTrustedOrigin } from "@/lib/auth/origin";
import { safePath } from "@/lib/auth/paths";
import {
  BUSINESS_ACTIONS,
  ROLE_PERMISSIONS,
  ROLE_TEMPLATES,
  roleAllows,
} from "@/lib/auth/permissions";

/**
 * The central authorization function, one check at a time.
 *
 * The lookups are injected, so each test changes exactly one fact and watches
 * which check refuses it — which is what pins the ORDER, not merely that some
 * check refuses. The database-backed half (does the resource belong to the
 * business) is the same tenant-scoped read every page already relies on, and
 * is exercised by the isolation suite.
 */

vi.mock("server-only", () => ({}));

const ORIGIN = "https://app.10xid.com";
const SECRET = "s".repeat(40);
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SESSION = "session_01ABC";

function ctx(role = "owner", organizationId: string | null = BUSINESS): SessionContext {
  return {
    sessionId: SESSION,
    workosUserId: "user_01ABC",
    userId: "33333333-3333-4333-8333-333333333333",
    email: "owner@example.com",
    fullName: null,
    role: "client",
    scope: {
      userId: "33333333-3333-4333-8333-333333333333",
      email: "owner@example.com",
      isStaff: false,
      organizationId,
      actingAs: null,
    },
    memberships: organizationId
      ? [
          {
            organizationId,
            role: role as never,
            organizationName: "Rotary",
            organizationSlug: "rotary",
            organizationType: "client",
          },
        ]
      : [],
    needsSecondFactor: false,
    realUserId: "33333333-3333-4333-8333-333333333333",
    realEmail: "owner@example.com",
    realIsStaff: false,
    actingAs: null,
  };
}

function active(c = ctx()): Identity {
  return { state: "active", workosUserId: c.workosUserId, sessionId: c.sessionId, ctx: c };
}

function deps(overrides: Partial<AuthorizationDeps> = {}): AuthorizationDeps {
  return {
    identity: async () => active(),
    business: async () => ({ type: "client", deletedAt: null }),
    resourceInBusiness: async () => true,
    expectedOrigin: () => ORIGIN,
    csrfSecret: () => SECRET,
    ...overrides,
  };
}

const mutation = (over: Partial<{ origin: string | null; csrfToken: unknown }> = {}) => ({
  origin: ORIGIN,
  csrfToken: csrfTokenFor(SESSION, SECRET),
  ...over,
});

async function reason(request: AuthorizationRequest, d = deps()) {
  const decision = await authorize(request, d);
  return decision.allowed ? "allowed" : decision.reason;
}

describe("the order of checks", () => {
  test("an owner, in their business, may act", async () => {
    const decision = await authorize({ action: "jobs.create", mutation: mutation() }, deps());
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.businessId).toBe(BUSINESS);
      expect(decision.ctx.scope.organizationId).toBe(BUSINESS);
    }
  });

  test("1. a state-changing request from anywhere but the app is refused first", async () => {
    // Even signed out: the origin is looked at before anything else is.
    const d = deps({ identity: async () => ({ state: "signed_out" }) });
    expect(await reason({ action: "jobs.create", mutation: mutation({ origin: "https://evil.10xid.com" }) }, d)).toBe(
      "bad_origin",
    );
    expect(await reason({ action: "jobs.create", mutation: mutation({ origin: null }) }, d)).toBe("bad_origin");
  });

  test("2. no WorkOS session", async () => {
    const d = deps({ identity: async () => ({ state: "signed_out" }) });
    expect(await reason({ action: "jobs.read" }, d)).toBe("signed_out");
    expect(await reason({ action: "jobs.create", mutation: mutation() }, d)).toBe("signed_out");
  });

  test("3. a state-changing request needs this session's CSRF token", async () => {
    expect(await reason({ action: "jobs.create", mutation: mutation({ csrfToken: undefined }) })).toBe("bad_csrf");
    expect(await reason({ action: "jobs.create", mutation: mutation({ csrfToken: "forged" }) })).toBe("bad_csrf");
    expect(
      await reason({ action: "jobs.create", mutation: mutation({ csrfToken: csrfTokenFor("session_other", SECRET) }) }),
    ).toBe("bad_csrf");
    // A read needs none.
    expect(await reason({ action: "jobs.read" })).toBe("allowed");
  });

  test("4. a WorkOS impersonation is refused: staff access is off", async () => {
    const d = deps({
      identity: async () => ({ state: "impersonated", workosUserId: "user_01ABC", sessionId: SESSION }),
    });
    expect(await reason({ action: "jobs.read" }, d)).toBe("impersonated");
  });

  test("5. signed in to WorkOS but bound to no account", async () => {
    const d = deps({
      identity: async () => ({
        state: "unbound",
        workosUserId: "user_01ABC",
        sessionId: SESSION,
        email: "someone@example.com",
        emailVerified: true,
        pendingBinding: true,
      }),
    });
    expect(await reason({ action: "jobs.read" }, d)).toBe("not_bound");
  });

  test("6. staff access is refused to everybody, owners included", async () => {
    expect(await reason({ action: STAFF_ACCESS })).toBe("staff_access_off");
  });

  test("7. no business on the session, and none named", async () => {
    const d = deps({ identity: async () => active(ctx("owner", null)) });
    expect(await reason({ action: "jobs.read" }, d)).toBe("no_business");
  });

  test("8. the business must exist, be a client business, and be live", async () => {
    expect(await reason({ action: "jobs.read" }, deps({ business: async () => null }))).toBe("business_unavailable");
    expect(
      await reason({ action: "jobs.read" }, deps({ business: async () => ({ type: "internal", deletedAt: null }) })),
    ).toBe("business_unavailable");
    expect(
      await reason({ action: "jobs.read" }, deps({ business: async () => ({ type: "client", deletedAt: new Date() }) })),
    ).toBe("business_unavailable");
  });

  test("9. a business the person is not a direct member of", async () => {
    expect(await reason({ action: "jobs.read", businessId: OTHER })).toBe("not_a_member");
  });

  test("10. a role whose template does not carry the action", async () => {
    for (const role of ["manager", "editor", "publisher", "asset_manager", "viewer", "member", "staff"]) {
      const d = deps({ identity: async () => active(ctx(role)) });
      expect(await reason({ action: "jobs.read" }, d), role).toBe("role_lacks_action");
    }
  });

  test("11. a resource that does not belong to the business", async () => {
    const d = deps({ resourceInBusiness: async () => false });
    expect(await reason({ action: "jobs.update_status", resource: { type: "job", id: OTHER } }, d)).toBe(
      "resource_not_found",
    );
  });

  test("the resource check is asked about THIS business", async () => {
    const resourceInBusiness = vi.fn(async () => true);
    await authorize({ action: "jobs.read", resource: { type: "job", id: OTHER } }, deps({ resourceInBusiness }));
    expect(resourceInBusiness).toHaveBeenCalledWith(expect.anything(), BUSINESS, { type: "job", id: OTHER });
  });
});

describe("the permission matrix (until it is written)", () => {
  test("the six role templates of Revision 2", () => {
    expect([...ROLE_TEMPLATES]).toEqual(["owner", "manager", "editor", "publisher", "asset_manager", "viewer"]);
  });

  test("owner holds every action; the other five hold none", () => {
    for (const action of BUSINESS_ACTIONS) expect(roleAllows("owner", action)).toBe(true);
    for (const role of ROLE_TEMPLATES.filter((r) => r !== "owner")) {
      expect(ROLE_PERMISSIONS[role].size, role).toBe(0);
    }
  });

  test("the roles from before the templates hold nothing", () => {
    for (const action of BUSINESS_ACTIONS) {
      expect(roleAllows("member", action)).toBe(false);
      expect(roleAllows("staff", action)).toBe(false);
    }
  });

  test("only an owner may transfer ownership or approve an agency grant", () => {
    for (const role of ROLE_TEMPLATES) {
      expect(roleAllows(role, "ownership.transfer")).toBe(role === "owner");
      expect(roleAllows(role, "grants.approve")).toBe(role === "owner");
    }
  });
});

describe("the request guards", () => {
  test("Origin: exact, or refused", () => {
    expect(isTrustedOrigin(ORIGIN, ORIGIN)).toBe(true);
    for (const origin of [null, "null", "", "https://evil.10xid.com", `${ORIGIN}.evil.test`, "http://app.10xid.com", `${ORIGIN}:443x`]) {
      expect(isTrustedOrigin(origin, ORIGIN), String(origin)).toBe(false);
    }
    expect(isTrustedOrigin(ORIGIN, null)).toBe(false);
  });

  test("CSRF: bound to one session and one secret", () => {
    const token = csrfTokenFor(SESSION, SECRET);
    expect(isValidCsrfToken(token, SESSION, SECRET)).toBe(true);
    expect(isValidCsrfToken(token, "session_other", SECRET)).toBe(false);
    expect(isValidCsrfToken(token, SESSION, "t".repeat(40))).toBe(false);
    expect(isValidCsrfToken(token, null, SECRET)).toBe(false);
    expect(isValidCsrfToken(token, SESSION, null)).toBe(false);
    expect(isValidCsrfToken(`${token}x`, SESSION, SECRET)).toBe(false);
    expect(isValidCsrfToken(42, SESSION, SECRET)).toBe(false);
  });

  test("return paths are local, or they are /", () => {
    expect(safePath("/jobs?x=1")).toBe("/jobs?x=1");
    for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "evil", "", "/a\nb", null]) {
      expect(safePath(bad), String(bad)).toBe("/");
    }
  });
});
