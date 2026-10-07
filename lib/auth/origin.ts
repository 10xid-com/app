import { NextRequest } from "next/server";

/**
 * THE ONE ORIGIN THE PORTAL ANSWERS ON.
 *
 * Derived from the WorkOS callback address (NEXT_PUBLIC_WORKOS_REDIRECT_URI),
 * which Revision 2 fixes at one address on app.10xid.com. Deriving it rather
 * than configuring it separately means the host the session cookie is issued
 * for and the origin state-changing requests must come from cannot disagree.
 *
 * No `server-only` import: proxy.ts uses this too.
 */

export function appOrigin(): string | null {
  const callback = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
  if (!callback) return null;
  try {
    return new URL(callback).origin;
  } catch {
    return null;
  }
}

/** The host part of the app origin, as a Host header carries it. */
export function appHost(): string | null {
  const origin = appOrigin();
  return origin ? new URL(origin).host : null;
}

/** Anything a browser may send that is not a plain read. */
export function isStateChanging(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

/**
 * An exact match, and nothing looser.
 *
 * SameSite=Lax does not stop a sibling 10XiD subdomain: to the browser it is
 * the same site, so its forms and fetches carry the portal's cookie. The Origin
 * header is what tells them apart, so it has to equal the app's origin
 * exactly — no suffix match, no wildcard, and a missing or "null" Origin is a
 * refusal rather than a pass.
 */
export function isTrustedOrigin(origin: string | null, expected: string | null): boolean {
  if (!origin || !expected || origin === "null") return false;
  return origin === expected;
}

/**
 * The request as the browser addressed it, for the WorkOS SDK.
 *
 * The SDK decides the session cookie's Secure flag from the request URL
 * (`getCookieOptions(request.url)`), on the callback and on every token
 * refresh. Behind Railway's proxy the URL the server sees is the address it is
 * bound to — plain http — so left alone the cookie would be issued WITHOUT
 * Secure. Rebuilding the URL on the app's own https origin, keeping the path,
 * query, method and headers (cookies included), gives the SDK the address the
 * browser actually used. Only called after the Host has been checked against
 * the app's.
 */
export function addressedToApp(request: NextRequest): NextRequest {
  const origin = appOrigin();
  if (!origin) return request;
  const current = new URL(request.url);
  return new NextRequest(`${origin}${current.pathname}${current.search}`, {
    method: request.method,
    headers: request.headers,
  });
}

/**
 * Revision 2's session settings, as configuration the SDK reads. Returns what
 * is wrong; empty means the deployment may serve. Checked at startup in
 * production (instrumentation.ts), so a deploy missing one stops rather than
 * issuing a cookie that is not what was agreed.
 */
export function sessionConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const callback = env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "";
  let url: URL | null = null;
  try {
    url = new URL(callback);
  } catch {
    problems.push("NEXT_PUBLIC_WORKOS_REDIRECT_URI is not a URL");
  }
  if (url && url.protocol !== "https:") problems.push("the WorkOS callback is not https");
  if (url && url.pathname !== "/callback") problems.push("the WorkOS callback is not /callback");
  if (env.WORKOS_COOKIE_DOMAIN) problems.push("WORKOS_COOKIE_DOMAIN must be unset (host-only cookie)");
  if (env.WORKOS_COOKIE_MAX_AGE !== "604800") problems.push("WORKOS_COOKIE_MAX_AGE must be 604800");
  if ((env.WORKOS_COOKIE_SAMESITE ?? "lax").toLowerCase() !== "lax") {
    problems.push("WORKOS_COOKIE_SAMESITE must be lax");
  }
  if ((env.WORKOS_COOKIE_PASSWORD ?? "").length < 32) {
    problems.push("WORKOS_COOKIE_PASSWORD must be at least 32 characters");
  }
  if (!env.WORKOS_CLIENT_ID) problems.push("WORKOS_CLIENT_ID is not set");
  if (!env.WORKOS_API_KEY) problems.push("WORKOS_API_KEY is not set");
  return problems;
}
