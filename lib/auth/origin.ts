/**
 * THE ONE ORIGIN THE PORTAL ANSWERS ON, AND THE LOGIN HOST'S.
 *
 *   PORTAL_HOST    app.10xid.com — this app.
 *   PRIMARY_HOST   login.10xid.com — where signing in happens.
 *
 * Read per call, not at module load, so a build without them does not bake
 * "unconfigured" into anything. https unless SESSION_COOKIE_SECURE=false
 * (plain-HTTP local development).
 *
 * No `server-only` import: proxy.ts uses this too.
 */

function scheme(): string {
  return process.env.SESSION_COOKIE_SECURE === "false" ? "http" : "https";
}

export function appHost(): string | null {
  const host = (process.env.PORTAL_HOST ?? "").trim().toLowerCase();
  return host || null;
}

export function appOrigin(): string | null {
  const host = appHost();
  return host ? `${scheme()}://${host}` : null;
}

export function loginHost(): string | null {
  const host = (process.env.PRIMARY_HOST ?? "").trim().toLowerCase();
  return host || null;
}

export function loginOrigin(): string | null {
  const host = loginHost();
  return host ? `${scheme()}://${host}` : null;
}

/** Anything a browser may send that is not a plain read. */
export function isStateChanging(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

/**
 * An exact match, and nothing looser.
 *
 * SameSite=Lax does not stop a sibling 10XiD subdomain — login.10xid.com
 * included: to the browser it is the same site, so its forms and fetches carry
 * the portal's cookie. The Origin header is what tells them apart, so it has
 * to equal the app's origin exactly — no suffix match, no wildcard, and a
 * missing or "null" Origin is a refusal rather than a pass.
 */
export function isTrustedOrigin(origin: string | null, expected: string | null): boolean {
  if (!origin || !expected || origin === "null") return false;
  return origin === expected;
}

/**
 * What is wrong with the deployment's configuration; empty means it may
 * serve. Checked at startup in production (instrumentation.ts).
 */
export function sessionConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const portal = (env.PORTAL_HOST ?? "").trim().toLowerCase();
  const login = (env.PRIMARY_HOST ?? "").trim().toLowerCase();
  const hostname = /^[a-z0-9.-]+(:\d+)?$/;
  if (!portal) problems.push("PORTAL_HOST is not set");
  else if (!hostname.test(portal)) problems.push("PORTAL_HOST must be a bare host name");
  if (!login) problems.push("PRIMARY_HOST is not set");
  else if (!hostname.test(login)) problems.push("PRIMARY_HOST must be a bare host name");
  if (portal && portal === login) problems.push("PORTAL_HOST and PRIMARY_HOST must differ");
  return problems;
}

/**
 * Variables left over from the WorkOS integration, which never went live.
 * Harmless — nothing reads them — so they are reported, not refused, and
 * removed after the cutover (README, "Cutover").
 */
export function obsoleteVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((n) => n.startsWith("WORKOS_") || n.startsWith("NEXT_PUBLIC_WORKOS_"));
}
