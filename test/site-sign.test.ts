import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { publicKeyOf, signRequest, signedString, signingKeyFrom } from "@/lib/sites/sign";
import { isPublicAddress, siteOriginFrom } from "@/lib/sites/client";

/**
 * The portal's half of the site-signing protocol (lib/sites/sign.ts), and the
 * address rules that keep the portal fetching only public websites.
 */

function freshKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const raw = `k1:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
  return { raw, key: signingKeyFrom(raw)! };
}

describe("signing", () => {
  test("the signature verifies with the public key a site stores", () => {
    const { key } = freshKey();
    const url = new URL("https://astro.example.com/api/admin/posts/save/?x=1");
    const body = Buffer.from("title=Hello");
    const actor = { email: "rana@example.com", name: "Rana", role: "owner", business: "B", can: ["edit" as const, "publish" as const] };
    const h = signRequest({ method: "POST", url, body, actor, key, now: 1_800_000_000_000 });

    expect(h["x-10xid-key"]).toBe("k1");
    expect(h["x-10xid-time"]).toBe("1800000000");
    expect(JSON.parse(Buffer.from(h["x-10xid-actor"], "base64url").toString())).toEqual(actor);

    const message = signedString({
      method: "POST",
      host: "astro.example.com",
      pathAndQuery: "/api/admin/posts/save/?x=1",
      time: "1800000000",
      bodySha256: createHash("sha256").update(body).digest("hex"),
      actor: h["x-10xid-actor"],
    });
    // Rebuild the public key from the 32 raw bytes a site keeps, as a site would.
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyOf(key.key) }, format: "jwk" });
    expect(verify(null, Buffer.from(message), pub, Buffer.from(h["x-10xid-signature"], "base64url"))).toBe(true);

    // Any change to what was signed breaks it.
    const otherHost = message.replace("astro.example.com", "evil.example.com");
    expect(verify(null, Buffer.from(otherHost), pub, Buffer.from(h["x-10xid-signature"], "base64url"))).toBe(false);
  });

  test("a malformed or non-Ed25519 key is no key", () => {
    expect(signingKeyFrom(undefined)).toBeNull();
    expect(signingKeyFrom("")).toBeNull();
    expect(signingKeyFrom("no-colon")).toBeNull();
    expect(signingKeyFrom("k1:not-a-key")).toBeNull();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(signingKeyFrom(`k1:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`)).toBeNull();
  });
});

describe("site addresses", () => {
  test.each([
    ["astro.vinylwraptoronto.com", "https://astro.vinylwraptoronto.com"],
    ["https://astro.vinylwraptoronto.com/blog/x?y", "https://astro.vinylwraptoronto.com"],
    ["HTTPS://Example.COM", "https://example.com"],
  ])("%s is %s", (input, origin) => {
    expect(siteOriginFrom(input)).toBe(origin);
  });

  test.each([
    "http://example.com",
    "https://10.0.0.1",
    "https://127.0.0.1",
    "https://[::1]",
    "https://example.com:8443",
    "https://user:pw@example.com",
    "https://localhost",
    "https://postgres.railway.internal",
    "https://printer.local",
    "ftp://example.com",
    "",
  ])("%s is refused", (input) => {
    expect(siteOriginFrom(input)).toBeNull();
  });

  test.each([
    ["8.8.8.8", true],
    ["104.16.1.1", true],
    ["10.1.2.3", false],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["172.20.0.1", false],
    ["192.168.1.1", false],
    ["100.64.0.1", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:10.0.0.1", false],
    ["2606:4700::6810:84e5", true],
  ])("%s public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});
