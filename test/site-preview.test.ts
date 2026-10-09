import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * "Preview on site" (app/api/website/posts/[id]/preview): the site's page for
 * a saved post, fetched signed as the person and served back sandboxed, with
 * the site as its base.
 */

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "104.21.1.1", family: 4 }] }));

const allowed = {
  allowed: true,
  ctx: { userId: "u1", email: "rana@example.com", fullName: "Rana" },
  businessId: "b1",
  role: "owner",
  via: null,
};
const decide = vi.fn(async () => allowed as unknown);
vi.mock("@/lib/auth/authorize", () => ({ authorizeRequest: () => decide() }));
vi.mock("@/lib/db/sites", () => ({ websiteFor: async () => ({ siteUrl: "https://astro.example.com" }) }));
vi.mock("@/lib/db/identity", () => ({ organizationById: async () => ({ name: "Vinyl Wrap Toronto" }) }));

const { privateKey } = generateKeyPairSync("ed25519");
const raw = `k1:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;

let asked: { url: string; headers: Record<string, string> } | null = null;
function siteAnswers(body: string, init: ResponseInit) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, request: RequestInit) => {
      asked = { url: String(url), headers: request.headers as Record<string, string> };
      return new Response(body, init);
    }),
  );
}

async function preview(id: string) {
  const { GET } = await import("@/app/api/website/posts/[id]/preview/route");
  return GET(new Request(`https://app.example.com/api/website/posts/${id}/preview`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.stubEnv("SITE_SIGNING_KEY", raw);
  decide.mockImplementation(async () => allowed);
  asked = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("previewing a saved post", () => {
  test("serves the site's page sandboxed, based on the site", async () => {
    siteAnswers('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Draft</title></head><body><h1>Draft</h1></body></html>', {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const res = await preview("42");
    expect(res.status).toBe(200);
    expect(asked!.url).toBe("https://astro.example.com/api/10xid/posts/42/preview/");
    expect(asked!.headers["x-10xid-signature"]).toBeTruthy();

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox;/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store, private");

    const html = await res.text();
    expect(html).toContain('<head><base href="https://astro.example.com/"><meta charset="UTF-8">');
    expect(html).toContain("<h1>Draft</h1>");
  });

  test("says so when the site has no page for it", async () => {
    siteAnswers(JSON.stringify({ error: "Not found." }), { status: 404, headers: { "content-type": "application/json" } });
    const res = await preview("42");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no preview for this post");
  });

  test("does not pass on an answer that is not a page", async () => {
    siteAnswers(JSON.stringify({ error: "Your role in 10XiD does not allow that." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const res = await preview("42");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("{");
  });

  test("asks nothing of the site for someone who may not edit", async () => {
    decide.mockImplementation(async () => ({ allowed: false, reason: "forbidden" }));
    siteAnswers("", { status: 200 });
    const res = await preview("42");
    expect(res.status).toBe(403);
    expect(asked).toBeNull();
  });

  test("asks nothing of the site for a post that is not saved", async () => {
    siteAnswers("", { status: 200 });
    const res = await preview("new");
    expect(res.status).toBe(404);
    expect(asked).toBeNull();
  });
});
