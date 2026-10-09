import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * Editing a video through its route, against the real database as the
 * application role and the real ffmpeg, with the media store standing in as
 * a folder: the edited video is stored as a new upload of the right size and
 * length, and the original is gone.
 */

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "video-route-test-"));
const stored = new Map<string, number>();
const deleted: string[] = [];

vi.mock("@/lib/integrations/media-bucket", () => {
  class BucketError extends Error {}
  return {
    BucketError,
    mediaBucketConfigured: () => true,
    // The store is a folder: a key is a file in it, and a presigned address is its path.
    presignedGet: async (key: string) => join(dir, key.replaceAll("/", "_")),
    putFile: async (key: string, path: string) => {
      copyFileSync(path, join(dir, key.replaceAll("/", "_")));
      stored.set(key, statSync(path).size);
    },
    deleteObject: async (key: string) => void deleted.push(key),
    abortMultipart: async () => undefined,
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

beforeAll(async () => {
  await db.connect();
  const { rows } = await db.query(`
    select (select id from organizations where slug = 'rotary') as rotary,
           (select id from users where email = 'paolo@brandingcentres.test') as paolo`);
  Object.assign(ids, rows[0]);
});

afterAll(async () => {
  await db.query(`delete from social_media_uploads where organization_id = $1`, [ids.rotary]);
  await db.end();
  const { closePool } = await import("@/lib/db/connection");
  await closePool();
  rmSync(dir, { recursive: true, force: true });
});

/** An uploaded 6-second 1280×720 video with sound, as the store and the table hold it. */
async function uploaded(): Promise<string> {
  const { newMediaKey, recordSocialMedia } = await import("@/lib/db/social");
  const key = newMediaKey(ids.rotary, "video/mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    join(dir, key.replaceAll("/", "_")),
  ]);
  const row = await recordSocialMedia(
    { organizationId: ids.rotary, userId: ids.paolo },
    { kind: "video", contentType: "video/mp4", storageKey: key, byteSize: 1000, width: 1280, height: 720, durationMs: 6000, uploadId: null, ready: true },
  );
  return row.id;
}

async function edit(id: string, body: unknown) {
  const { POST } = await import("@/app/api/social/videos/[id]/edit/route");
  const res = await POST(new Request(`https://app.example.com/api/social/videos/${id}/edit`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
  return { res, body: (await res.json()) as { id?: string; width?: number; height?: number; durationMs?: number; error?: string } };
}

const keep = (startMs: number, endMs: number) => ({ startMs, endMs, crop: { ratio: null, position: 0.5 }, mute: false, texts: [] });

describe.skipIf(!hasFfmpeg)("editing a video", () => {
  test("stores the edit as a new upload and forgets the original", async () => {
    const id = await uploaded();
    const original = (await db.query(`select storage_key from social_media_uploads where id = $1`, [id])).rows[0].storage_key;
    const { res, body } = await edit(id, {
      ...keep(1000, 5000),
      crop: { ratio: 1, position: 0.5 },
      mute: true,
      texts: [{ text: "Full wrap", position: "bottom", style: "box", startMs: 1000, endMs: 3000 }],
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ width: 720, height: 720 });
    expect(body.durationMs).toBeGreaterThan(3800);
    expect(body.durationMs).toBeLessThan(4200);

    const row = (await db.query(`select kind, content_type, ready, storage_key, byte_size from social_media_uploads where id = $1`, [body.id])).rows[0];
    expect(row).toMatchObject({ kind: "video", content_type: "video/mp4", ready: true });
    expect(Number(row.byte_size)).toBe(stored.get(row.storage_key));
    expect((await db.query(`select 1 from social_media_uploads where id = $1`, [id])).rowCount).toBe(0);
    expect(deleted).toContain(original);
  }, 120_000);

  test("keeps at least 3 seconds", async () => {
    const id = await uploaded();
    expect((await edit(id, keep(1000, 2500))).res.status).toBe(400);
  }, 60_000);

  test("refuses edits it cannot read, and a video that is not there", async () => {
    const id = await uploaded();
    expect((await edit(id, { ...keep(0, 6000), crop: { ratio: 5, position: 0.5 } })).res.status).toBe(400);
    expect((await edit(id, { ...keep(0, 6000), texts: Array(4).fill({ text: "x", position: "top", style: "box", startMs: 0, endMs: 1 }) })).res.status).toBe(400);
    expect((await edit("00000000-0000-0000-0000-000000000000", keep(0, 6000))).res.status).toBe(410);
  }, 60_000);
});
