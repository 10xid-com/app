import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

/**
 * Signing the portal's requests to a business's website.
 *
 * The Website channel edits and publishes a site's blog for the business's
 * people. The portal holds no password or token for the site. It signs each
 * request with ITS OWN Ed25519 private key, and the site checks the signature
 * with the portal's public key — which is public, and sits in the site's own
 * configuration. A site connection therefore stores no secret (0028), and a
 * leak of the database or of a site's settings forges nothing.
 *
 * The protocol is version 1, and the other half lives in each site (for Vinyl
 * Wrap Toronto: src/lib/portal.ts). What is signed, one item per line:
 *
 *     10xid-site-v1
 *     METHOD
 *     host                   the site's host: a signature for one site is
 *                            worthless on another
 *     path and query
 *     unix time in seconds   the site accepts it within 90 seconds
 *     sha256 of the body, hex
 *     the actor header, as sent
 *
 * The actor says who is acting and what the portal allows them on the site
 * (`edit`, `publish`), decided here from the permission matrix. The site
 * re-checks it on the routes that care.
 *
 * SITE_SIGNING_KEY on the app service holds `<key id>:<base64url PKCS#8 DER>`.
 * The key id lets a new key be added to a site before the old one is retired.
 * Make one with `npx tsx scripts/site-signing-key.ts`.
 */

export type SiteCan = "edit" | "publish";

export type SiteActor = {
  email: string;
  name: string;
  role: string;
  business: string;
  can: SiteCan[];
};

export type SigningKey = { id: string; key: KeyObject };

export function signedString(input: {
  method: string;
  host: string;
  pathAndQuery: string;
  time: string;
  bodySha256: string;
  actor: string;
}): string {
  return [
    "10xid-site-v1",
    input.method.toUpperCase(),
    input.host.toLowerCase(),
    input.pathAndQuery,
    input.time,
    input.bodySha256,
    input.actor,
  ].join("\n");
}

/** Parse SITE_SIGNING_KEY. Null when it is unset or malformed: the channel then says so. */
export function signingKeyFrom(raw: string | undefined): SigningKey | null {
  const value = raw?.trim();
  if (!value) return null;
  const at = value.indexOf(":");
  if (at < 1) return null;
  const id = value.slice(0, at);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) return null;
  try {
    const key = createPrivateKey({ key: Buffer.from(value.slice(at + 1), "base64url"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return { id, key };
  } catch {
    return null;
  }
}

/** The public half as a site stores it: 32 raw bytes, base64url. */
export function publicKeyOf(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  return String(jwk.x);
}

/** The headers that make a request to a site a signed portal request. */
export function signRequest(input: {
  method: string;
  url: URL;
  body: Buffer;
  actor: SiteActor;
  key: SigningKey;
  now?: number;
}): Record<string, string> {
  const actor = Buffer.from(JSON.stringify(input.actor)).toString("base64url");
  const time = String(Math.floor((input.now ?? Date.now()) / 1000));
  const message = signedString({
    method: input.method,
    host: input.url.host,
    pathAndQuery: input.url.pathname + input.url.search,
    time,
    bodySha256: createHash("sha256").update(input.body).digest("hex"),
    actor,
  });
  const signature = sign(null, Buffer.from(message), input.key.key).toString("base64url");
  return {
    "x-10xid-key": input.key.id,
    "x-10xid-time": time,
    "x-10xid-actor": actor,
    "x-10xid-signature": signature,
  };
}
