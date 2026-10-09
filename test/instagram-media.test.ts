import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * Posting to Instagram through the routes, end to end, against the real
 * database as the application role, with the media store and Instagram
 * standing in:
 *
 *   a video comes up in parts      each exactly its size; finishing needs
 *                                  every part, and checks the whole
 *   a Reel is posted as a Reel     from a presigned address, with its options
 *   posted files are deleted       from the store and the table
 *   a long video in a carousel     is refused before Instagram is asked
 *   a photo must be a JPEG         of a shape the feed takes
 */

const store = new Map<string, Uint8Array>();
const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();

vi.mock("@/lib/integrations/media-bucket", () => {
  class BucketError extends Error {}
  return {
    BucketError,
    mediaBucketConfigured: () => true,
    putObject: async (key: string, body: Uint8Array) => void store.set(key, body),
    deleteObject: async (key: string) => void store.delete(key),
    objectSize: async (key: string) => store.get(key)?.length ?? null,
    presignedGet: async (key: string, seconds: number) => `https://store.example/${key}?X-Amz-Expires=${seconds}&X-Amz-Signature=sig`,
    startMultipart: async (key: string) => {
      const id = randomBytes(8).toString("hex");
      uploads.set(id, { key, parts: new Map() });
      return id;
    },
    uploadPart: async (key: string, uploadId: string, part: number, body: Uint8Array) => {
      uploads.get(uploadId)!.parts.set(part, body);
      return `"etag-${part}"`;
    },
    completeMultipart: async (key: string, uploadId: string, parts: { part: number; etag: string }[]) => {
      const u = uploads.get(uploadId)!;
      if (parts.some((p) => p.etag !== `"etag-${p.part}"` || !u.parts.has(p.part))) throw new BucketError("InvalidPart");
      const whole = Buffer.concat([...u.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
      store.set(key, new Uint8Array(whole));
      uploads.delete(uploadId);
    },
    abortMultipart: async (_key: string, uploadId: string) => void uploads.delete(uploadId),
  };
});

const ids = { rotary: "", paolo: "" };
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
const PART = 8 * 1024 * 1024;

beforeAll(async () => {
  await db.connect();
  const { rows } = await db.query(`
    select (select id from organizations where slug = 'rotary') as rotary,
           (select id from users where email = 'paolo@brandingcentres.test') as paolo`);
  ids.rotary = rows[0].rotary;
  ids.paolo = rows[0].paolo;
  vi.stubEnv("CHANNEL_TOKEN_KEY", randomBytes(32).toString("base64url"));
  vi.stubEnv("INSTAGRAM_APP_ID", "1234567890");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "secret");
  const { connectSocial } = await import("@/lib/db/social");
  await db.query(
    `update social_connections set disconnected_at = now(), token_ciphertext = null, token_expires_at = null where organization_id = $1 and disconnected_at is null`,
    [ids.rotary],
  );
  await connectSocial(
    { organizationId: ids.rotary, userId: ids.paolo },
    "instagram",
    {
      accountId: "17841400000000001",
      scopedId: "990000000000001",
      username: "vinylwraptoronto_test",
      token: "IGAA-test",
      expiresAt: new Date(Date.now() + 60 * 86_400_000),
      scopes: [],
      agencyGrantId: null,
    },
  );
});

beforeEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await db.query(
    `update social_connections set disconnected_at = now(), token_ciphertext = null, token_expires_at = null where organization_id = $1 and disconnected_at is null`,
    [ids.rotary],
  );
  await db.query(`delete from social_media_uploads where organization_id = $1`, [ids.rotary]);
  await db.end();
  const { closePool } = await import("@/lib/db/connection");
  await closePool();
  vi.unstubAllEnvs();
});

const json = (url: string, body: unknown) =>
  new Request(`https://app.example.com${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function startVideo(byteSize: number, durationMs = 12_000) {
  const { POST } = await import("@/app/api/social/videos/route");
  const res = await POST(json("/api/social/videos", { contentType: "video/mp4", byteSize, width: 1080, height: 1920, durationMs }));
  return { res, body: (await res.json()) as { id: string; partBytes: number; error?: string } };
}

async function sendPart(id: string, part: number, bytes: Uint8Array<ArrayBuffer>) {
  const { PUT } = await import("@/app/api/social/videos/[id]/parts/[part]/route");
  const res = await PUT(new Request(`https://app.example.com/x`, { method: "PUT", body: bytes }), {
    params: Promise.resolve({ id, part: String(part) }),
  });
  return { res, body: (await res.json()) as { etag?: string; error?: string } };
}

async function complete(id: string, parts: { part: number; etag: string }[]) {
  const { POST } = await import("@/app/api/social/videos/[id]/complete/route");
  const res = await POST(json(`/api/social/videos/${id}/complete`, { parts }), { params: Promise.resolve({ id }) });
  return { res, body: (await res.json()) as { id?: string; error?: string } };
}

async function uploadWholeVideo(byteSize: number, durationMs?: number): Promise<string> {
  const { body } = await startVideo(byteSize, durationMs);
  const file = randomBytes(byteSize);
  const parts = [];
  for (let n = 1; n <= Math.ceil(byteSize / PART); n++) {
    const sent = await sendPart(body.id, n, new Uint8Array(file.subarray((n - 1) * PART, n * PART)));
    parts.push({ part: n, etag: sent.body.etag! });
  }
  expect((await complete(body.id, parts)).res.status).toBe(200);
  return body.id;
}

/** Instagram, answering as it does, and keeping what it was asked. */
function instagram() {
  const asked: { url: string; params: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const params = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
      asked.push({ url, params });
      if (url.endsWith("/media_publish")) return Response.json({ id: "media-1" });
      if (url.endsWith("/media")) return Response.json({ id: `container-${asked.length}` });
      if (url.includes("fields=status_code")) return Response.json({ status_code: "FINISHED" });
      if (url.includes("fields=permalink")) return Response.json({ permalink: "https://www.instagram.com/reel/abc/" });
      return Response.json({ error: { message: `unexpected ${url}` } }, { status: 400 });
    }),
  );
  return asked;
}

async function post(body: unknown) {
  const { POST } = await import("@/app/api/instagram/posts/route");
  const res = await POST(json("/api/instagram/posts", body));
  return { res, body: (await res.json()) as { permalink?: string; error?: string } };
}

describe("a video upload", () => {
  test("is refused when it is not a video Instagram takes", async () => {
    expect((await startVideo(301 * 1024 * 1024)).res.status).toBe(400);
    expect((await startVideo(1000, 2000)).res.status).toBe(400);
    const { POST } = await import("@/app/api/social/videos/route");
    const webm = await POST(json("/api/social/videos", { contentType: "video/webm", byteSize: 10, width: 1, height: 1, durationMs: 5000 }));
    expect(webm.status).toBe(400);
  });

  test("takes each part at exactly its size, and finishes only with every part", async () => {
    const size = PART + 1234;
    const { body } = await startVideo(size);
    expect(body.partBytes).toBe(PART);

    expect((await sendPart(body.id, 1, new Uint8Array(PART - 1))).res.status).toBe(400);
    expect((await sendPart(body.id, 3, new Uint8Array(10))).res.status).toBe(400);
    const one = await sendPart(body.id, 1, new Uint8Array(PART));
    expect(one.res.status).toBe(200);

    expect((await complete(body.id, [{ part: 1, etag: one.body.etag! }])).res.status).toBe(400);
    const two = await sendPart(body.id, 2, new Uint8Array(1234));
    const done = await complete(body.id, [
      { part: 1, etag: one.body.etag! },
      { part: 2, etag: two.body.etag! },
    ]);
    expect(done.res.status).toBe(200);
    const row = await db.query(`select ready, upload_id, storage_key from social_media_uploads where id = $1`, [body.id]);
    expect(row.rows[0]).toMatchObject({ ready: true, upload_id: null });
    expect(store.get(row.rows[0].storage_key)?.length).toBe(size);

    // Finished is finished: no more parts.
    expect((await sendPart(body.id, 1, new Uint8Array(PART))).res.status).toBe(410);
  });
});

describe("posting", () => {
  test("a video on its own goes up as a Reel, from a presigned address, and is then deleted", async () => {
    const id = await uploadWholeVideo(PART + 10, 20_000);
    const key = (await db.query(`select storage_key from social_media_uploads where id = $1`, [id])).rows[0].storage_key;
    const asked = instagram();

    const { res, body } = await post({ caption: "New wrap", media: [id], reel: { shareToFeed: false, coverMs: 4500 } });
    expect(res.status).toBe(200);
    expect(body.permalink).toBe("https://www.instagram.com/reel/abc/");

    const created = asked.find((a) => a.url.endsWith("/17841400000000001/media"))!;
    expect(created.params).toMatchObject({ media_type: "REELS", caption: "New wrap", share_to_feed: "false", thumb_offset: "4500" });
    expect(created.params.video_url).toBe(`https://store.example/${key}?X-Amz-Expires=10800&X-Amz-Signature=sig`);
    expect(asked.some((a) => a.url.endsWith("/media_publish"))).toBe(true);

    expect(store.has(key)).toBe(false);
    expect((await db.query(`select 1 from social_media_uploads where id = $1`, [id])).rowCount).toBe(0);
  });

  test("a carousel mixes photos and videos as carousel items", async () => {
    const { POST } = await import("@/app/api/social/photos/route");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x04, 0x38, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    const form = new FormData();
    form.set("photo", new File([jpeg], "p.jpg", { type: "image/jpeg" }));
    const photoRes = await POST(new Request("https://app.example.com/api/social/photos", { method: "POST", body: form }));
    expect(photoRes.status).toBe(200);
    const photoId = ((await photoRes.json()) as { id: string }).id;
    const videoId = await uploadWholeVideo(1000, 30_000);

    const asked = instagram();
    const { res } = await post({ caption: "Before and after", media: [photoId, videoId] });
    expect(res.status).toBe(200);
    const creates = asked.filter((a) => a.url.endsWith("/media")).map((a) => a.params);
    expect(creates[0]).toMatchObject({ is_carousel_item: "true" });
    expect(creates[0].image_url).toBeTruthy();
    expect(creates[1]).toMatchObject({ media_type: "VIDEO", is_carousel_item: "true" });
    expect(creates[2]).toMatchObject({ media_type: "CAROUSEL", caption: "Before and after" });
    expect(creates[2].children.split(",")).toHaveLength(2);
  });

  test("a video over a minute is refused in a carousel before Instagram is asked", async () => {
    const a = await uploadWholeVideo(1000, 90_000);
    const b = await uploadWholeVideo(1000, 10_000);
    const asked = instagram();
    const { res, body } = await post({ caption: "", media: [a, b] });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/up to a minute/);
    expect(asked).toHaveLength(0);
  });

  test("a video still uploading cannot be posted", async () => {
    const { body } = await startVideo(1000);
    const asked = instagram();
    expect((await post({ caption: "", media: [body.id] })).res.status).toBe(410);
    expect(asked).toHaveLength(0);
  });
});

describe("a photo", () => {
  test("must be a JPEG, and of a shape Instagram's feed takes to post there", async () => {
    const { POST } = await import("@/app/api/social/photos/route");
    const send = (bytes: Buffer) => {
      const form = new FormData();
      form.set("photo", new File([new Uint8Array(bytes)], "p", { type: "image/jpeg" }));
      return POST(new Request("https://app.example.com/api/social/photos", { method: "POST", body: form }));
    };
    expect((await send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))).status).toBe(415);
    // 3000 × 1000 is 3:1: a Facebook post can carry it; Instagram's feed (to 1.91:1) cannot.
    const wide = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0xe8, 0x0b, 0xb8, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    const res = await send(wide);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const asked = instagram();
    const refused = await post({ caption: "", media: [id] });
    expect(refused.res.status).toBe(422);
    expect(asked).toHaveLength(0);
  });
});
