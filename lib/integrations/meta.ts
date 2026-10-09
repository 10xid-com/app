import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * What the Instagram and Facebook channels share: Meta's errors, the sealing
 * of stored access tokens, and Meta's signed notices.
 *
 * Tokens are sealed with CHANNEL_TOKEN_KEY (32 random bytes, base64url, on the
 * app service): AES-256-GCM, bound to the business, the channel and the
 * account, so the database alone holds nothing usable and a ciphertext moved
 * to another row does not open.
 */

export class MetaError extends Error {
  constructor(
    message: string,
    /** Meta's own error code: 190 is a token it no longer accepts. */
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "MetaError";
  }
  get signedOut(): boolean {
    return this.code === 190;
  }
}

export function channelTokenKey(): Buffer | null {
  const raw = process.env.CHANNEL_TOKEN_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64url");
  return key.length === 32 ? key : null;
}

/** What a sealed token is bound to: a ciphertext moved to another row does not open. */
export type TokenBinding = { organizationId: string; channel: string; accountId: string };

const binding = (b: TokenBinding) => Buffer.from(`${b.organizationId}:${b.channel}:${b.accountId}`);

/** AES-256-GCM, as `v1.<iv>.<ciphertext>.<tag>`, base64url. */
export function sealToken(token: string, bound: TokenBinding): string {
  const key = channelTokenKey();
  if (!key) throw new MetaError("The portal has no CHANNEL_TOKEN_KEY to store the token with.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(binding(bound));
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv, sealed, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function openToken(sealed: string, bound: TokenBinding): string {
  const key = channelTokenKey();
  const [version, iv, data, tag] = sealed.split(".");
  const unreadable = () => new MetaError("The stored access cannot be read. Connect the account again.");
  if (!key || version !== "v1" || !iv || !data || !tag) throw unreadable();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(binding(bound));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw unreadable();
  }
}

/**
 * Meta's signed notice (deauthorize, data deletion): `<sig>.<payload>`, the
 * signature an HMAC-SHA256 of the payload with the app secret. Answers with
 * the person's app-scoped id when it is genuine.
 */
export function verifySignedRequest(appSecret: string, signed: string): string | null {
  const [sig, payload] = signed.split(".", 2);
  if (!sig || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { algorithm?: string; user_id?: string | number };
    if (data.algorithm?.toUpperCase() !== "HMAC-SHA256" || data.user_id === undefined) return null;
    return String(data.user_id);
  } catch {
    return null;
  }
}
