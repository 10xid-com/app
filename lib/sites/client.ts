import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { signRequest, signingKeyFrom, type SiteActor } from "./sign";

/**
 * Talking to a business's website on behalf of one of its people.
 *
 * Every call is signed (./sign.ts) and goes only to the address on the
 * business's live site connection, which an owner typed. Because a server
 * fetching an address a person typed is how a server gets talked into fetching
 * its own neighbours, the address is held to a public https origin twice: when
 * it is saved (siteOriginFrom) and before every request (assertPublicHost,
 * which resolves the name and refuses private, loopback and link-local
 * answers).
 */

export class SiteError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "SiteError";
  }
}

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".lan", ".home", ".corp", ".test", ".invalid", ".example"];

/**
 * A typed address as the https origin it names, or null. Accepts
 * "astro.example.com" or "https://astro.example.com/anything" and keeps only
 * the origin; refuses http, IP literals, ports, credentials, single-label and
 * private-suffix names.
 */
export function siteOriginFrom(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host) || host.startsWith("[")) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  if (/^\d+$/.test(host.split(".").at(-1)!)) return null;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return `https://${host}`;
}

/** Is this address one a public website could have? */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (v === 6) {
    const s = address.toLowerCase();
    if (s === "::" || s === "::1") return false;
    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return false; // link-local
    if (s.startsWith("fc") || s.startsWith("fd")) return false; // unique local
    if (s.startsWith("::ffff:")) return isPublicAddress(s.slice(7));
    return true;
  }
  return false;
}

async function assertPublicHost(host: string): Promise<void> {
  let answers: { address: string }[];
  try {
    answers = await lookup(host, { all: true });
  } catch {
    throw new SiteError(`${host} could not be found.`);
  }
  if (answers.length === 0 || !answers.every((a) => isPublicAddress(a.address))) {
    throw new SiteError(`${host} does not point at a public website.`);
  }
}

export function siteSigningConfigured(): boolean {
  return signingKeyFrom(process.env.SITE_SIGNING_KEY) !== null;
}

/**
 * One signed call. `path` is the site's own path (with its trailing slash);
 * `form` is sent as a form submission, which is what the site's save routes
 * read. Answers with the site's status and JSON body; a non-JSON or
 * unreachable answer is a SiteError saying so.
 */
export async function siteRequest(input: {
  siteUrl: string;
  actor: SiteActor;
  method: "GET" | "POST";
  path: string;
  form?: Record<string, string | string[]>;
  /** A file upload: sent as multipart, and signed over its exact bytes like any other body. */
  multipart?: FormData;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = signingKeyFrom(process.env.SITE_SIGNING_KEY);
  if (!key) throw new SiteError("The portal has no site-signing key yet (SITE_SIGNING_KEY).");

  const origin = siteOriginFrom(input.siteUrl);
  if (!origin) throw new SiteError("The connected address is not a public https site.");
  const url = new URL(input.path, origin);
  if (url.origin !== origin) throw new SiteError("That path leaves the site.");
  await assertPublicHost(url.hostname);

  let body = Buffer.alloc(0);
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(input.form)) for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
    body = Buffer.from(params.toString());
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (input.multipart) {
    // Encoded once, here, so the bytes signed are the bytes sent.
    const encoded = new Response(input.multipart);
    body = Buffer.from(await encoded.arrayBuffer());
    headers["content-type"] = encoded.headers.get("content-type") ?? "multipart/form-data";
  }
  Object.assign(headers, signRequest({ method: input.method, url, body, actor: input.actor, key }));

  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method,
      headers,
      body: input.method === "GET" ? undefined : body,
      redirect: "manual",
      cache: "no-store",
      // An image takes longer to send than a form.
      signal: AbortSignal.timeout(input.multipart ? 60_000 : 20_000),
    });
  } catch {
    throw new SiteError(`${url.host} did not answer.`);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SiteError(
      response.status === 404
        ? `${url.host} does not accept the portal yet.`
        : `${url.host} answered ${response.status} with something other than the portal's answer.`,
      response.status,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SiteError(`${url.host} sent an answer the portal cannot read.`, response.status);
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}
