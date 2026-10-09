import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * The Facebook channel through its routes, against the real database as the
 * application role, with Facebook and the media store standing in:
 *
 *   the sign-in return     takes a code only with this browser's state, for
 *                          the business open, and only with Page permissions
 *   one Page               is connected, with only the Page's token, sealed
 *   several Pages          the person chooses; their token waits sealed in
 *                          their own cookie, for this business only
 *   posting                text, several photos in one post, or a video on
 *                          its own, each as Facebook expects it
 *   Meta's notice          ends the connection
 */

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const store = new Map<string, Uint8Array>();
vi.mock("@/lib/integrations/media-bucket", () => {
  class BucketError extends Error {}
  return {
    BucketError,
    mediaBucketConfigured: () => true,
    putObject: async (key: string, body: Uint8Array) => void store.set(key, body),
    deleteObject: async (key: string) => void store.delete(key),
    objectSize: async (key: string) => store.get(key)?.length ?? null,
    presignedGet: async (key: string) => `https://store.example/${key}?sig`,
    startMultipart: async () => "u",
    uploadPart: async () => '"e"',
    completeMultipart: async () => undefined,
    abortMultipart: async () => undefined,
  };
});

const ids = { rotary: "", northstar: "", paolo: "" };
vi.mock("@/lib/auth/authorize", () => ({
  authorizeRequest: async () => ({
    allowed: true,
    ctx: { userId: ids.paolo, email: "paolo@brandingcentres.test" },
    businessId: ids.rotary,
    role: "owner",
    via: null,
  }),
}));

const db = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await db.connect();
  const { rows } = await db.query(`
    select (select id from organizations where slug = 'rotary') as rotary,
           (select id from organizations where slug = 'northstar') as northstar,
           (select id from users where email = 'paolo@brandingcentres.test') as paolo`);
  Object.assign(ids, rows[0]);
  vi.stubEnv("CHANNEL_TOKEN_KEY", randomBytes(32).toString("base64url"));
  vi.stubEnv("FACEBOOK_APP_ID", "1234567890");
  vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret");
  vi.stubEnv("PORTAL_HOST", "app.example.com");
});

const endFacebook = () =>
  db.query(
    `update social_connections set disconnected_at = now(), token_ciphertext = null, token_expires_at = null
      where organization_id in ($1, $2) and channel = 'facebook' and disconnected_at is null`,
    [ids.rotary, ids.northstar],
  );

beforeEach(async () => {
  vi.unstubAllGlobals();
  jar.clear();
  await endFacebook();
});

afterAll(async () => {
  await endFacebook();
  await db.query(`delete from social_media where organization_id = $1`, [ids.rotary]);
  await db.end();
  const { closePool } = await import("@/lib/db/connection");
  await closePool();
  vi.unstubAllEnvs();
});

type Page = { id: string; name: string; access_token: string; tasks?: string[] };

/** Facebook, answering as it does, and keeping what it was asked. */
function facebook(opts: { pages?: Page[]; granted?: string[] } = {}) {
  const asked: { url: string; method: string; params: Record<string, string> }[] = [];
  const granted = opts.granted ?? ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "public_profile"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const params = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
      asked.push({ url, method: init?.method ?? "GET", params });
      const path = new URL(url).pathname.replace(/^\/v[\d.]+/, "");
      if (path === "/oauth/access_token") {
        return Response.json({ access_token: new URL(url).searchParams.has("fb_exchange_token") ? "EAA-long" : "EAA-short" });
      }
      if (path === "/me") return Response.json({ id: "1000000001", name: "Paolo" });
      if (path === "/me/permissions") return Response.json({ data: granted.map((permission) => ({ permission, status: "granted" })) });
      if (path === "/me/accounts") return Response.json({ data: opts.pages ?? [] });
      if (path.endsWith("/photos")) return Response.json({ id: `photo-${asked.length}`, post_id: "page_post_1" });
      if (path.endsWith("/feed")) return Response.json({ id: "page_post_2" });
      if (path.endsWith("/videos")) return Response.json({ id: "video-1" });
      if (new URL(url).searchParams.get("fields") === "permalink_url") return Response.json({ permalink_url: "https://www.facebook.com/p/1" });
      return Response.json({ error: { message: `unexpected ${url}`, code: 100 } }, { status: 400 });
    }),
  );
  return asked;
}

const PAGE: Page = { id: "200000000000001", name: "Vinyl Wrap Toronto", access_token: "EAA-page-token", tasks: ["CREATE_CONTENT", "MANAGE"] };

async function signInReturn(query: string) {
  const { GET } = await import("@/app/api/facebook/callback/route");
  return GET(new Request(`https://app.example.com/api/facebook/callback?${query}`));
}

async function startedState(): Promise<string> {
  const { GET } = await import("@/app/api/facebook/connect/route");
  const res = await GET(new Request("https://app.example.com/api/facebook/connect"));
  const to = new URL(res.headers.get("location")!);
  expect(to.origin).toBe("https://www.facebook.com");
  expect(to.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/facebook/callback");
  expect(to.searchParams.get("scope")).toContain("pages_manage_posts");
  const [name, ...value] = (res.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  expect(name).toMatch(/portal_facebook_state$/);
  jar.set(name, decodeURIComponent(value.join("=")));
  return to.searchParams.get("state")!;
}

describe("the sign-in return", () => {
  test("connects the one Page, storing only its token, sealed", async () => {
    const state = await startedState();
    facebook({ pages: [PAGE] });
    const res = await signInReturn(`state=${state}&code=abc`);
    expect(res.headers.get("location")).toBe("https://app.example.com/channels/facebook?done=connected");

    const row = await db.query(
      `select account_id, scoped_id, username, token_ciphertext, token_expires_at from social_connections
        where organization_id = $1 and channel = 'facebook' and disconnected_at is null`,
      [ids.rotary],
    );
    expect(row.rows[0]).toMatchObject({ account_id: PAGE.id, scoped_id: "1000000001", username: PAGE.name, token_expires_at: null });
    expect(row.rows[0].token_ciphertext).toMatch(/^v1\./);
    expect(row.rows[0].token_ciphertext).not.toContain("EAA");
    const { channelToken, socialConnectionFor } = await import("@/lib/db/social");
    const conn = await socialConnectionFor({ organizationId: ids.rotary, userId: ids.paolo }, "facebook");
    expect(await channelToken({ organizationId: ids.rotary, userId: ids.paolo }, conn!)).toBe("EAA-page-token");
  });

  test("refuses a code without this browser's state, before asking Facebook anything", async () => {
    await startedState();
    const asked = facebook({ pages: [PAGE] });
    const res = await signInReturn(`state=someone-elses&code=abc`);
    expect(res.headers.get("location")).toContain("error=state");
    expect(asked).toHaveLength(0);
  });

  test("refuses a sign-in without permission to post", async () => {
    const state = await startedState();
    facebook({ pages: [PAGE], granted: ["pages_show_list", "public_profile"] });
    const res = await signInReturn(`state=${state}&code=abc`);
    expect(res.headers.get("location")).toContain("error=permissions");
  });

  test("says so when there is no Page to post to", async () => {
    const state = await startedState();
    facebook({ pages: [{ ...PAGE, tasks: ["ANALYZE"] }] });
    const res = await signInReturn(`state=${state}&code=abc`);
    expect(res.headers.get("location")).toContain("error=nopages");
  });

  test("with several Pages, asks which, keeping the person's token sealed in their cookie for this business", async () => {
    const state = await startedState();
    facebook({ pages: [PAGE, { ...PAGE, id: "200000000000002", name: "Branding Centres" }] });
    const res = await signInReturn(`state=${state}&code=abc`);
    expect(res.headers.get("location")).toBe("https://app.example.com/channels/facebook?choose=1");
    const pending = decodeURIComponent(/portal_facebook_pending=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]);
    expect(pending).not.toContain("EAA");

    const { openPending } = await import("@/lib/integrations/facebook-pending");
    expect(openPending(pending, ids.rotary)).toEqual({ person: "1000000001", token: "EAA-long" });
    expect(openPending(pending, ids.northstar)).toBeNull();
    expect(openPending(pending.replace(/^\d+/, "1000000002"), ids.rotary)).toBeNull();

    const stored = await db.query(`select 1 from social_connections where organization_id = $1 and channel = 'facebook' and disconnected_at is null`, [ids.rotary]);
    expect(stored.rowCount).toBe(0);
  });
});

async function connected() {
  const { connectSocial } = await import("@/lib/db/social");
  return connectSocial({ organizationId: ids.rotary, userId: ids.paolo }, "facebook", {
    accountId: PAGE.id,
    scopedId: "1000000001",
    username: PAGE.name,
    token: "EAA-page-token",
    expiresAt: null,
    scopes: [],
    agencyGrantId: null,
  });
}

async function photo(): Promise<string> {
  const { POST } = await import("@/app/api/social/photos/route");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0xe8, 0x0b, 0xb8, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  const form = new FormData();
  form.set("photo", new File([new Uint8Array(jpeg)], "p.jpg", { type: "image/jpeg" }));
  const res = await POST(new Request("https://app.example.com/api/social/photos", { method: "POST", body: form }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function video(): Promise<string> {
  const { recordSocialMedia, newMediaKey } = await import("@/lib/db/social");
  const row = await recordSocialMedia(
    { organizationId: ids.rotary, userId: ids.paolo },
    {
      kind: "video",
      contentType: "video/mp4",
      storageKey: newMediaKey(ids.rotary, "video/mp4"),
      byteSize: 1000,
      width: 1080,
      height: 1920,
      durationMs: 90_000,
      uploadId: null,
      ready: true,
    },
  );
  return row.id;
}

async function post(body: unknown) {
  const { POST } = await import("@/app/api/facebook/posts/route");
  const res = await POST(new Request("https://app.example.com/api/facebook/posts", { method: "POST", body: JSON.stringify(body) }));
  return { res, body: (await res.json()) as { permalink?: string; error?: string } };
}

describe("posting to the Page", () => {
  test("text on its own goes to the feed", async () => {
    await connected();
    const asked = facebook();
    const { res } = await post({ caption: "Open Saturday 10 to 4.", media: [] });
    expect(res.status).toBe(200);
    const feed = asked.find((a) => a.url.endsWith(`/${PAGE.id}/feed`))!;
    expect(feed.params).toEqual({ message: "Open Saturday 10 to 4." });
  });

  test("several photos go up unpublished, then into one post", async () => {
    await connected();
    const media = [await photo(), await photo()];
    const asked = facebook();
    const { res } = await post({ caption: "Before and after", media });
    expect(res.status).toBe(200);
    const photos = asked.filter((a) => a.url.endsWith(`/${PAGE.id}/photos`));
    expect(photos).toHaveLength(2);
    expect(photos.every((p) => p.params.published === "false" && p.params.url.startsWith("https://store.example/"))).toBe(true);
    const feed = asked.find((a) => a.url.endsWith(`/${PAGE.id}/feed`))!;
    expect(feed.params.message).toBe("Before and after");
    expect(JSON.parse(feed.params["attached_media[0]"]).media_fbid).toMatch(/^photo-/);
    expect(JSON.parse(feed.params["attached_media[1]"]).media_fbid).toMatch(/^photo-/);
    // Photos are deleted once posted.
    expect((await db.query(`select 1 from social_media where id = any($1)`, [media])).rowCount).toBe(0);
  });

  test("a video goes up on its own, with the text as its description", async () => {
    await connected();
    const id = await video();
    const asked = facebook();
    const { res, body } = await post({ caption: "Full colour change", media: [id] });
    expect(res.status).toBe(200);
    expect(body.permalink).toContain("/videos/video-1");
    const v = asked.find((a) => a.url.endsWith(`/${PAGE.id}/videos`))!;
    expect(v.params).toMatchObject({ description: "Full colour change" });
    expect(v.params.file_url).toMatch(/^https:\/\/store\.example\//);
  });

  test("a video with photos is refused before Facebook is asked", async () => {
    await connected();
    const media = [await video(), await photo()];
    const asked = facebook();
    const { res, body } = await post({ caption: "", media });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/on its own/);
    expect(asked).toHaveLength(0);
  });

  test("nothing to post is refused", async () => {
    await connected();
    const asked = facebook();
    expect((await post({ caption: "   ", media: [] })).res.status).toBe(400);
    expect(asked).toHaveLength(0);
  });
});

describe("Meta's notice", () => {
  test("ends the Facebook connection of the person who removed the app", async () => {
    await connected();
    const { revokeSocial, socialConnectionFor } = await import("@/lib/db/social");
    expect(await revokeSocial("facebook", "1000000001", "deauthorize")).toBe(1);
    expect(await socialConnectionFor({ organizationId: ids.rotary, userId: ids.paolo }, "facebook")).toBeNull();
  });
});

describe("the sidebar's channels", () => {
  test("are the ones this business has connected, and no other business's", async () => {
    const { connectedChannels } = await import("@/lib/db/channels");
    expect((await connectedChannels({ organizationId: ids.rotary, userId: ids.paolo })).has("facebook")).toBe(false);
    await connected();
    expect((await connectedChannels({ organizationId: ids.rotary, userId: ids.paolo })).has("facebook")).toBe(true);
    expect((await connectedChannels({ organizationId: ids.northstar, userId: ids.paolo })).has("facebook")).toBe(false);
  });
});
