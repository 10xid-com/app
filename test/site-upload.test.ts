import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { publicKeyOf, signedString, signingKeyFrom } from "@/lib/sites/sign";

/**
 * A file sent to a site through siteRequest (multipart), checked the way the
 * site checks it (vinylwraptoronto src/lib/portal.ts): the signature covers
 * the exact bytes that arrive, and those bytes still parse as the upload.
 */

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "104.21.1.1", family: 4 }] }));

const { privateKey } = generateKeyPairSync("ed25519");
const raw = `k1:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("uploading a file to a site", () => {
  test("is signed over the bytes sent, which parse back to the same file", async () => {
    vi.stubEnv("SITE_SIGNING_KEY", raw);
    let sent: { url: string; headers: Record<string, string>; body: Buffer } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        sent = { url: String(url), headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Buffer) };
        return Response.json({ path: "/wp-content/uploads/2026/10/x.png", url: "https://img.example.com/2026/10/x.png" });
      }),
    );
    const { siteRequest } = await import("@/lib/sites/client");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const form = new FormData();
    form.set("file", new File([png], "wrap.png", { type: "image/png" }));
    const actor = { email: "rana@example.com", name: "Rana", role: "owner", business: "B", can: ["edit" as const] };
    const res = await siteRequest({
      siteUrl: "https://astro.example.com",
      actor,
      method: "POST",
      path: "/api/admin/media/upload/",
      multipart: form,
    });
    expect(res.status).toBe(200);

    const got = sent!;
    expect(got.url).toBe("https://astro.example.com/api/admin/media/upload/");
    expect(got.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);

    // The site's check: the signature over sha256 of what arrived.
    const message = signedString({
      method: "POST",
      host: "astro.example.com",
      pathAndQuery: "/api/admin/media/upload/",
      time: got.headers["x-10xid-time"],
      bodySha256: createHash("sha256").update(got.body).digest("hex"),
      actor: got.headers["x-10xid-actor"],
    });
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyOf(signingKeyFrom(raw)!.key) }, format: "jwk" });
    expect(verify(null, Buffer.from(message), pub, Buffer.from(got.headers["x-10xid-signature"], "base64url"))).toBe(true);

    // And what the site then reads out of those bytes is the file.
    const parsed = await new Response(new Uint8Array(got.body), { headers: { "content-type": got.headers["content-type"] } }).formData();
    const file = parsed.get("file") as File;
    expect(file.name).toBe("wrap.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
  });
});
