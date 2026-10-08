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
  AGENCY_NEVER,
  agencyAllows,
  BUSINESS_ACTIONS,
  canAssignRole,
  canManageMember,
  JOB_STATUSES,
  ROLE_TEMPLATES,
  roleAllows,
  statusChangeAction,
  statusesFor,
  type BusinessAction,
  type JobStatus,
  type RoleTemplate,
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
/** The session cookie's secret value, which the CSRF token is keyed by. */
const TOKEN = "t".repeat(43);
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SESSION = "session_01ABC";

function ctx(role = "owner", organizationId: string | null = BUSINESS): SessionContext {
  return {
    sessionId: SESSION,
    authSessionId: "auth_session_01",
    authUserId: "auth_user_01",
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
    agencyAccess: [],
    absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    needsSecondFactor: false,
    realUserId: "33333333-3333-4333-8333-333333333333",
    realEmail: "owner@example.com",
    realIsStaff: false,
    actingAs: null,
  };
}

function active(c = ctx()): Identity {
  return { state: "active", sessionId: c.sessionId, csrfToken: csrfTokenFor(TOKEN), ctx: c };
}

function deps(overrides: Partial<AuthorizationDeps> = {}): AuthorizationDeps {
  return {
    identity: async () => active(),
    business: async () => ({ type: "client", deletedAt: null }),
    resourceInBusiness: async () => true,
    expectedOrigin: () => ORIGIN,
    ...overrides,
  };
}

const mutation = (over: Partial<{ origin: string | null; csrfToken: unknown }> = {}) => ({
  origin: ORIGIN,
  csrfToken: csrfTokenFor(TOKEN),
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

  test("2. no live portal session", async () => {
    const d = deps({ identity: async () => ({ state: "signed_out" }) });
    expect(await reason({ action: "jobs.read" }, d)).toBe("signed_out");
    expect(await reason({ action: "jobs.create", mutation: mutation() }, d)).toBe("signed_out");
  });

  test("3. a state-changing request needs this session's CSRF token", async () => {
    expect(await reason({ action: "jobs.create", mutation: mutation({ csrfToken: undefined }) })).toBe("bad_csrf");
    expect(await reason({ action: "jobs.create", mutation: mutation({ csrfToken: "forged" }) })).toBe("bad_csrf");
    expect(
      await reason({ action: "jobs.create", mutation: mutation({ csrfToken: csrfTokenFor("another session's token") }) }),
    ).toBe("bad_csrf");
    // A read needs none.
    expect(await reason({ action: "jobs.read" })).toBe("allowed");
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
    for (const role of ["member", "staff"]) {
      const d = deps({ identity: async () => active(ctx(role)) });
      expect(await reason({ action: "jobs.read" }, d), role).toBe("role_lacks_action");
    }
    const viewer = deps({ identity: async () => active(ctx("viewer")) });
    expect(await reason({ action: "jobs.read" }, viewer)).toBe("allowed");
    expect(await reason({ action: "jobs.create", mutation: mutation() }, viewer)).toBe("role_lacks_action");
    const editor = deps({ identity: async () => active(ctx("editor")) });
    expect(await reason({ action: "jobs.approve", mutation: mutation() }, editor)).toBe("role_lacks_action");
    const manager = deps({ identity: async () => active(ctx("manager")) });
    expect(await reason({ action: "jobs.approve", mutation: mutation() }, manager)).toBe("allowed");
    expect(await reason({ action: "billing.manage", mutation: mutation() }, manager)).toBe("role_lacks_action");
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

/**
 * The matrix as decided on 2026-10-07, written out in full and independently
 * of lib/auth/permissions.ts: every role against every action, so a change to
 * either side that the other does not share fails here, allowed and denied
 * alike.
 */
const O = "owner", M = "manager", E = "editor", P = "publisher", A = "asset_manager", V = "viewer";
const EXPECTED: Record<BusinessAction, readonly RoleTemplate[]> = {
  "business.view": [O, M, E, P, A, V],
  "jobs.read": [O, M, E, P, A, V],
  "jobs.create": [O, M, E, P, A],
  "jobs.update_status": [O, M, E, P],
  "jobs.approve": [O, M],
  "jobs.attach_drive_folder": [O, M, A],
  "staff.manage": [O, M],
  "pages.edit": [O, M, E, P],
  "pages.publish": [O, M, P],
  "vault.read": [O, M, E, P, A, V],
  "vault.write": [O, M, E, P, A],
  "vault.share": [O, M, A],
  "social.compose": [O, M, E, P],
  "social.publish": [O, M, P],
  "social.connect": [O, M],
  "domains.manage": [O],
  "grants.approve": [O],
  "billing.manage": [O],
  "ownership.transfer": [O],
};

describe("the permission matrix", () => {
  test("the six role templates of Revision 2", () => {
    expect([...ROLE_TEMPLATES]).toEqual(["owner", "manager", "editor", "publisher", "asset_manager", "viewer"]);
  });

  test("the expected table names every action, and nothing else", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...BUSINESS_ACTIONS].sort());
  });

  test.each(BUSINESS_ACTIONS.map((a) => [a]))("%s: exactly the expected roles, every other role refused", (action) => {
    for (const role of ROLE_TEMPLATES) {
      expect(roleAllows(role, action), `${role} ${action}`).toBe(EXPECTED[action].includes(role));
    }
  });

  test("allowed and refused through the central function, for every role and action", async () => {
    for (const role of ROLE_TEMPLATES) {
      const d = deps({ identity: async () => active(ctx(role)) });
      for (const action of BUSINESS_ACTIONS) {
        expect(await reason({ action }, d), `${role} ${action}`).toBe(
          EXPECTED[action].includes(role) ? "allowed" : "role_lacks_action",
        );
      }
    }
  });

  test("owner holds every action", () => {
    for (const action of BUSINESS_ACTIONS) expect(roleAllows("owner", action)).toBe(true);
  });

  test("the roles from before the templates hold nothing", () => {
    for (const action of BUSINESS_ACTIONS) {
      expect(roleAllows("member", action)).toBe(false);
      expect(roleAllows("staff", action)).toBe(false);
      expect(roleAllows("nonsense", action)).toBe(false);
    }
  });

  test("only an owner may transfer ownership or approve an agency grant", () => {
    for (const role of ROLE_TEMPLATES) {
      expect(roleAllows(role, "ownership.transfer")).toBe(role === "owner");
      expect(roleAllows(role, "grants.approve")).toBe(role === "owner");
    }
  });
});

describe("who may give, change or take away which role", () => {
  test("an owner may give any role, and manage anybody", () => {
    for (const target of ROLE_TEMPLATES) {
      expect(canAssignRole("owner", target), target).toBe(true);
      expect(canManageMember("owner", target), target).toBe(true);
    }
  });

  test("a manager may give and manage every role but owner", () => {
    for (const target of ROLE_TEMPLATES) {
      expect(canAssignRole("manager", target), target).toBe(target !== "owner");
      expect(canManageMember("manager", target), target).toBe(target !== "owner");
    }
    // Legacy roles are not owners: a manager may tidy them up, never give them.
    expect(canManageMember("manager", "member")).toBe(true);
    expect(canAssignRole("manager", "member")).toBe(false);
    expect(canAssignRole("owner", "staff")).toBe(false);
  });

  test("nobody else may give or manage any role", () => {
    for (const actor of ["editor", "publisher", "asset_manager", "viewer", "member", "staff"]) {
      for (const target of [...ROLE_TEMPLATES, "member"]) {
        expect(canAssignRole(actor, target), `${actor} → ${target}`).toBe(false);
        expect(canManageMember(actor, target), `${actor} → ${target}`).toBe(false);
      }
    }
  });
});

describe("which job status changes are decisions", () => {
  const cases: [JobStatus, JobStatus, "jobs.update_status" | "jobs.approve"][] = [
    // Moving work along.
    ["draft", "open", "jobs.update_status"],
    ["open", "in_progress", "jobs.update_status"],
    ["in_progress", "awaiting_approval", "jobs.update_status"],
    ["awaiting_approval", "in_progress", "jobs.update_status"],
    ["changes_requested", "in_progress", "jobs.update_status"],
    ["approved", "completed", "jobs.update_status"],
    // Making a decision.
    ["awaiting_approval", "approved", "jobs.approve"],
    ["awaiting_approval", "changes_requested", "jobs.approve"],
    ["open", "cancelled", "jobs.approve"],
    ["in_progress", "approved", "jobs.approve"],
    // Undoing one.
    ["approved", "in_progress", "jobs.approve"],
    ["approved", "awaiting_approval", "jobs.approve"],
    ["cancelled", "open", "jobs.approve"],
    ["completed", "in_progress", "jobs.approve"],
    // Completing work nobody approved.
    ["awaiting_approval", "completed", "jobs.approve"],
    ["in_progress", "completed", "jobs.approve"],
  ];

  test.each(cases)("%s → %s needs %s", (from, to, action) => {
    expect(statusChangeAction(from, to)).toBe(action);
  });

  test("an editor and a publisher may move work along but never decide", () => {
    for (const role of ["editor", "publisher"]) {
      expect(statusesFor(role, "awaiting_approval")).toEqual(["draft", "open", "in_progress", "awaiting_approval"]);
      expect(statusesFor(role, "approved")).toEqual(["approved", "completed"]);
      expect(statusesFor(role, "cancelled")).toEqual(["cancelled"]);
    }
  });

  test("owners and managers may make every move", () => {
    for (const role of ["owner", "manager"]) {
      for (const from of JOB_STATUSES) expect(statusesFor(role, from)).toEqual([...JOB_STATUSES]);
    }
  });

  test("an asset manager and a viewer may make none", () => {
    for (const role of ["asset_manager", "viewer"]) {
      for (const from of JOB_STATUSES) expect(statusesFor(role, from)).toEqual([from]);
    }
  });
});

describe("agency access", () => {
  const GRANT = "44444444-4444-4444-8444-444444444444";
  const AGENCY = "55555555-5555-4555-8555-555555555555";
  function viaGrant(role: string, opts: { member?: string } = {}) {
    // A member of the agency (or, with `member`, of the business itself).
    const c = ctx(opts.member ?? "owner", opts.member ? BUSINESS : AGENCY);
    c.scope.organizationId = BUSINESS;
    c.agencyAccess = [
      {
        grantId: GRANT,
        organizationId: BUSINESS,
        organizationName: "Rotary",
        organizationSlug: "rotary",
        agencyOrganizationId: AGENCY,
        agencyName: "Branding Centres",
        role,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ];
    return deps({ identity: async () => active(c) });
  }

  test("a live grant opens the business at its role, and says so", async () => {
    const d = viaGrant("editor");
    const decision = await authorize({ action: "jobs.create", mutation: mutation() }, d);
    expect(decision).toMatchObject({ allowed: true, businessId: BUSINESS, role: "editor", via: { grantId: GRANT, agencyName: "Branding Centres" } });
    expect(await reason({ action: "jobs.approve", mutation: mutation() }, d)).toBe("role_lacks_action");
  });

  test("never: managing people, grants, billing, domains or ownership — even as a manager", async () => {
    const d = viaGrant("manager");
    for (const action of AGENCY_NEVER) {
      expect(await reason({ action, mutation: mutation() }, d), action).toBe("role_lacks_action");
    }
    // Everything else a manager does, an agency manager does.
    expect(await reason({ action: "jobs.approve", mutation: mutation() }, d)).toBe("allowed");
    for (const action of BUSINESS_ACTIONS) {
      expect(agencyAllows("manager", action), action).toBe(roleAllows("manager", action) && !AGENCY_NEVER.has(action));
    }
  });

  test("a grant reaches only its own business", async () => {
    expect(await reason({ action: "jobs.read", businessId: OTHER }, viaGrant("editor"))).toBe("not_a_member");
  });

  test("a direct membership wins over a grant into the same business", async () => {
    const d = viaGrant("viewer", { member: "owner" });
    const decision = await authorize({ action: "staff.manage", mutation: mutation() }, d);
    expect(decision).toMatchObject({ allowed: true, role: "owner", via: null });
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

  test("CSRF: bound to one session's secret", () => {
    const token = csrfTokenFor(TOKEN);
    expect(isValidCsrfToken(token, csrfTokenFor(TOKEN))).toBe(true);
    expect(isValidCsrfToken(token, csrfTokenFor("u".repeat(43)))).toBe(false);
    expect(isValidCsrfToken(token, null)).toBe(false);
    expect(isValidCsrfToken(`${token}x`, csrfTokenFor(TOKEN))).toBe(false);
    expect(isValidCsrfToken("", csrfTokenFor(TOKEN))).toBe(false);
    expect(isValidCsrfToken(42, csrfTokenFor(TOKEN))).toBe(false);
  });

  test("return paths are local, or they are /", () => {
    expect(safePath("/jobs?x=1")).toBe("/jobs?x=1");
    for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "evil", "", "/a\nb", null]) {
      expect(safePath(bad), String(bad)).toBe("/");
    }
  });
});
