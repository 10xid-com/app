import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getJob } from "@/lib/db";
import { organizationById } from "@/lib/db/identity";
import { CSRF_FIELD, CSRF_HEADER, isValidCsrfToken } from "./csrf";
import { appOrigin, isTrustedOrigin } from "./origin";
import { type BusinessAction, allows } from "./permissions";
import { resolveIdentity, type Identity, type SessionContext } from "./session";
import { safePath } from "./paths";
import { mayUseChatBoss } from "./chat-boss";

/**
 * THE CENTRAL AUTHORIZATION FUNCTION.
 *
 * Every protected page, server action and route handler in this app passes
 * through here (test/authorization-coverage.test.ts fails the build when one
 * does not). It answers one question — may THIS person do THIS action, in THIS
 * business, to THIS resource — from the database, on every request. Being
 * signed in grants nothing on its own; it only says who is asking.
 *
 * The checks, in order. Each stops at the first failure, and the reason is
 * logged with the action and ids (never an address):
 *
 *   1. state-changing requests only: the Origin is exactly the app's origin
 *   2. there is a live portal session, from a live sign-in that
 *      passed the authenticator, of a bound account (session.ts) signed_out
 *   3. state-changing requests only: a valid CSRF token for it   bad_csrf
 *   4. (retired: impersonation and unbound sign-ins never reach the portal)
 *   5. (retired)
 *   6. the action is a business action, not staff access         staff_access_off
 *   7. a business is named                                       no_business
 *   8. it exists, is a client business, and is not deleted       business_unavailable
 *   9. the person holds a direct membership in it, or a live     not_a_member
 *      agency grant into it (approved, in date, on it by name,
 *      not blocked, still in the agency)
 *  10. their role template carries the action — and through a    role_lacks_action
 *      grant, never the actions agency access cannot carry
 *      (AGENCY_NEVER: managing people, grants, billing, domains,
 *      ownership)
 *  11. the resource, if one is named, belongs to that business   resource_not_found
 *
 * Underneath, Postgres row-level security enforces tenant isolation again on
 * every query, so a mistake here still cannot read across businesses.
 *
 * WHAT IS DELIBERATELY NOT HERE YET: agency grants and assignments, blocks on
 * named people, freelancer grants, and the 24-hour and five-minute freshness
 * rules. Those wait on the block rules, the permission matrix and the check
 * order for them, which the build brief lists as still open.
 */

/**
 * Staff access, under its one name.
 *
 * Turned off on 2026-10-07: Branding Centres is to reach clients only through
 * client-approved agency grants, which are not built yet. The staff screens
 * (Clients, Keys, Act as, the /chat workspace) are still in the code and ask
 * for this action; no role carries it, so they are refused.
 */
export const STAFF_ACCESS = "platform.staff" as const;

export type Action = BusinessAction | typeof STAFF_ACCESS;

export type Resource = { type: "job"; id: string };

export type DenyReason =
  | "bad_origin"
  | "signed_out"
  | "bad_csrf"
  | "staff_access_off"
  | "no_business"
  | "business_unavailable"
  | "not_a_member"
  | "role_lacks_action"
  | "resource_not_found";

/** How the person holds the business: null for a membership, else the agency grant. */
export type Via = { grantId: string; agencyName: string; expiresAt: Date } | null;

export type Decision =
  | { allowed: true; ctx: SessionContext; businessId: string; role: string; via: Via }
  | { allowed: false; reason: DenyReason; identity: Identity };

export type AuthorizationRequest = {
  action: Action;
  /** Defaults to the business the session is on (see resolveIdentity). */
  businessId?: string | null;
  resource?: Resource;
  /** Present for a state-changing request: what it carried. */
  mutation?: { origin: string | null; csrfToken: unknown };
};

/** The lookups the decision needs, injectable so the order can be tested without a database. */
export type AuthorizationDeps = {
  identity: () => Promise<Identity>;
  business: (id: string) => Promise<{ type: string; deletedAt: Date | null } | null>;
  resourceInBusiness: (ctx: SessionContext, businessId: string, resource: Resource) => Promise<boolean>;
  expectedOrigin: () => string | null;
};

const defaultDeps: AuthorizationDeps = {
  identity: resolveIdentity,
  business: organizationById,
  resourceInBusiness: async (ctx, businessId, resource) => {
    switch (resource.type) {
      case "job": {
        // Read through the tenant-scoped helper, as this business: another
        // business's job is invisible under row-level security, so it is not
        // found rather than found-and-refused.
        const job = await getJob({ ...ctx.scope, organizationId: businessId }, resource.id);
        return job !== null && job.organizationId === businessId;
      }
    }
  },
  expectedOrigin: appOrigin,
};

export async function authorize(
  request: AuthorizationRequest,
  deps: AuthorizationDeps = defaultDeps,
): Promise<Decision> {
  const deny = (reason: DenyReason, identity: Identity): Decision => {
    const who = identity.state === "signed_out" ? "anonymous" : identity.ctx.userId;
    console.warn(`[authz] deny ${request.action} reason=${reason} who=${who}`);
    return { allowed: false, reason, identity };
  };

  // 1.
  if (request.mutation && !isTrustedOrigin(request.mutation.origin, deps.expectedOrigin())) {
    return deny("bad_origin", { state: "signed_out" });
  }

  // 2.
  const identity = await deps.identity();
  if (identity.state === "signed_out") return deny("signed_out", identity);

  // 3. The token is bound to the portal session, which exists from here on.
  if (request.mutation) {
    if (!isValidCsrfToken(request.mutation.csrfToken, identity.csrfToken)) {
      return deny("bad_csrf", identity);
    }
  }

  const { ctx } = identity;

  // 6.
  if (request.action === STAFF_ACCESS) return deny("staff_access_off", identity);
  const action = request.action;

  // 7.
  const businessId =
    request.businessId === undefined ? ctx.scope.organizationId : request.businessId;
  if (!businessId) return deny("no_business", identity);

  // 8.
  const business = await deps.business(businessId);
  if (!business || business.type !== "client" || business.deletedAt) {
    return deny("business_unavailable", identity);
  }

  // 9. A direct membership, else a live agency grant (lib/db/agency.ts).
  // Freelancer routes do not exist yet.
  const membership = ctx.memberships.find((m) => m.organizationId === businessId);
  const grant = membership ? undefined : (ctx.agencyAccess ?? []).find((a) => a.organizationId === businessId);
  if (!membership && !grant) return deny("not_a_member", identity);
  const role = membership ? membership.role : grant!.role;
  const via: Via = grant ? { grantId: grant.grantId, agencyName: grant.agencyName, expiresAt: grant.expiresAt } : null;

  // 10.
  if (!allows(role, action, via)) return deny("role_lacks_action", identity);

  // 11.
  if (request.resource && !(await deps.resourceInBusiness(ctx, businessId, request.resource))) {
    return deny("resource_not_found", identity);
  }

  return {
    allowed: true,
    ctx: { ...ctx, scope: { ...ctx.scope, organizationId: businessId } },
    businessId,
    role,
    via,
  };
}

/* ------------------------------------------------------------------ */
/* The three ways in: a page, a server action, a route handler.        */
/* ------------------------------------------------------------------ */

export type Granted = { ctx: SessionContext; businessId: string; role: string; via: Via };

/**
 * For a page. Signed out goes to sign-in and back; a missing resource is a
 * 404, the same as one that never existed; anything else refused goes to the
 * access page, which explains where the person stands.
 */
export async function requirePage(
  action: Action,
  options: { returnPath: string; resource?: Resource; businessId?: string | null },
): Promise<Granted> {
  const decision = await authorize({
    action,
    resource: options.resource,
    businessId: options.businessId,
  });
  if (decision.allowed) return decision;
  if (decision.reason === "signed_out") redirect(signInPath(options.returnPath));
  if (decision.reason === "resource_not_found") notFound();
  if (decision.reason === "no_business") redirect(BUSINESS_CHOOSER);
  redirect(`/access?reason=${decision.reason}`);
}

/**
 * For a server action. The Origin and CSRF token are checked before anything
 * else, and a failure there is an error rather than a redirect: a forged
 * request gets nothing it can follow.
 */
export async function requireAction(
  action: Action,
  formData: FormData,
  options: { returnPath: string; resource?: Resource } = { returnPath: "/" },
): Promise<Granted> {
  const h = await headers();
  const decision = await authorize({
    action,
    resource: options.resource,
    mutation: { origin: h.get("origin"), csrfToken: formData.get(CSRF_FIELD) },
  });
  if (decision.allowed) return decision;
  if (decision.reason === "bad_origin" || decision.reason === "bad_csrf") {
    throw new Error("This request did not come from the portal.");
  }
  if (decision.reason === "signed_out") redirect(signInPath(options.returnPath));
  if (decision.reason === "no_business") redirect(BUSINESS_CHOOSER);
  redirect(`/access?reason=${decision.reason}`);
}

/**
 * For a route handler. Returns the decision for the handler to turn into a
 * response; a state-changing method must carry the CSRF token in a header.
 */
export async function authorizeRequest(
  request: Request,
  action: Action,
  options: { resource?: Resource } = {},
): Promise<Decision> {
  const mutation = ["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())
    ? undefined
    : { origin: request.headers.get("origin"), csrfToken: request.headers.get(CSRF_HEADER) };
  return authorize({ action, resource: options.resource, mutation });
}

/**
 * For the few state-changing requests that act on the person rather than on a
 * business — signing out. Origin and CSRF, nothing else; any live portal
 * session may end itself.
 */
export async function requireSameOriginRequest(formData: FormData): Promise<void> {
  const h = await headers();
  if (!isTrustedOrigin(h.get("origin"), appOrigin())) {
    throw new Error("This request did not come from the portal.");
  }
  const identity = await resolveIdentity();
  if (identity.state === "signed_out") return;
  if (!isValidCsrfToken(formData.get(CSRF_FIELD), identity.csrfToken)) {
    throw new Error("This request did not come from the portal.");
  }
}

/**
 * Where somebody with no business on screen is sent: the business switcher,
 * which lists the businesses they belong to (or says they belong to none).
 */
export const BUSINESS_CHOOSER = "/business";

/**
 * For the one kind of page that is about the PERSON rather than a business:
 * choosing which business to open. A live portal session is the whole
 * requirement; anything shown must be the person's own (their memberships).
 */
export async function requireSignedIn(returnPath: string): Promise<SessionContext> {
  const identity = await resolveIdentity();
  if (identity.state === "signed_out") redirect(signInPath(returnPath));
  return identity.ctx;
}

/**
 * For a server action of the same kind: the Origin and CSRF checks, then a
 * live session. A forged request is an error, as in requireAction; signed out
 * goes to sign-in.
 */
export async function requireSignedInAction(formData: FormData, returnPath: string): Promise<SessionContext> {
  const h = await headers();
  if (!isTrustedOrigin(h.get("origin"), appOrigin())) {
    throw new Error("This request did not come from the portal.");
  }
  const identity = await resolveIdentity();
  if (identity.state === "signed_out") redirect(signInPath(returnPath));
  if (!isValidCsrfToken(formData.get(CSRF_FIELD), identity.csrfToken)) {
    throw new Error("This request did not come from the portal.");
  }
  return identity.ctx;
}

/* ------------------------------------------------------------------ */
/* Chat Boss (/chat): named people, on a business they belong to.     */
/* ------------------------------------------------------------------ */

/**
 * For a Chat Boss page. The business-scoped check first — a live session, a
 * business open, membership of it, a role that reads its jobs — then the
 * person must be on the Chat Boss list (./chat-boss.ts). Anybody else gets
 * the same 404 as a page that does not exist.
 */
export async function requireChatBossPage(returnPath: string): Promise<Granted> {
  const granted = await requirePage("jobs.read", { returnPath });
  if (!mayUseChatBoss(granted.ctx.realEmail) || granted.ctx.actingAs) notFound();
  return granted;
}

/** For a Chat Boss server action: Origin and CSRF, then the same as the page. */
export async function requireChatBossAction(formData: FormData): Promise<Granted> {
  const granted = await requireAction("jobs.read", formData, { returnPath: "/chat" });
  if (!mayUseChatBoss(granted.ctx.realEmail) || granted.ctx.actingAs) notFound();
  return granted;
}

/** For a Chat Boss route handler; a state-changing method carries the CSRF header. */
export async function authorizeChatBossRequest(request: Request): Promise<Decision> {
  const decision = await authorizeRequest(request, "jobs.read");
  if (decision.allowed && (!mayUseChatBoss(decision.ctx.realEmail) || decision.ctx.actingAs)) {
    return { allowed: false, reason: "role_lacks_action", identity: { state: "signed_out" } };
  }
  return decision;
}

/**
 * The single entry of every staff screen: Clients, Keys, Act as and the /chat
 * workspace. It asks the central function for STAFF_ACCESS, which no role
 * carries, so it always refuses while staff access is off — the screens stay
 * in the code, and nothing reaches them.
 */
export async function requireStaffAccess(returnPath = "/"): Promise<SessionContext> {
  const decision = await authorize({ action: STAFF_ACCESS });
  if (decision.allowed) return decision.ctx;
  if (decision.reason === "signed_out") redirect(signInPath(returnPath));
  redirect(`/access?reason=${decision.reason}`);
}

/** Into the handoff: the login host signs the person in, then sends them back to returnPath. */
export function signInPath(returnPath: string): string {
  return `/auth/sso/start?path=${encodeURIComponent(safePath(returnPath))}`;
}
