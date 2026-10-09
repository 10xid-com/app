import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";
import {
  InstagramTakenError,
  connectInstagram,
  deleteSocialMedia,
  disconnectInstagram,
  instagramFor,
  instagramToken,
  markSocialMediaReady,
  newMediaKey,
  recordSocialMedia,
  revokeInstagram,
  socialMediaById,
  socialMediaFor,
  takeExpiredSocialMedia,
  type SocialOwner,
} from "@/lib/db/social";
import { jpegSize, openToken, sealToken, verifySignedRequest } from "@/lib/integrations/instagram";
import { igStateMatches, newIgState } from "@/lib/integrations/instagram-state";
import { closePool } from "@/lib/db/connection";

/**
 * The Instagram channel (login's 0034), against a real database as the
 * application role, and the pieces it trusts nothing without:
 *
 *   the token is sealed           not readable from the row, and bound to it
 *   a business sees its own       another business's connection is not there
 *   one business per account      an account connected elsewhere cannot be taken
 *   disconnecting erases          the token goes; the record stays
 *   Meta's notice is checked      only a correctly signed one ends a connection
 *   media belongs to a business   another business cannot see or post this
 *                                 one's files; only whole, unexpired ones post
 */

const KEY = randomBytes(32).toString("base64url");
const owner = new Client({ connectionString: process.env.DATABASE_URL });
let rotary = "";
let northstar = "";
let paolo = "";

beforeAll(async () => {
  await owner.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'paolo@brandingcentres.test') as paolo
  `);
  ({ rotary, northstar, paolo } = rows[0]);
  expect(rotary, "seed data missing — run npm run db:seed").toBeTruthy();
});

beforeEach(() => {
  vi.stubEnv("CHANNEL_TOKEN_KEY", KEY);
});

afterAll(async () => {
  await owner.query(`update social_connections set disconnected_at = now(), token_ciphertext = null, token_expires_at = null where disconnected_at is null and organization_id in ($1, $2)`, [rotary, northstar]);
  await owner.query(`delete from social_media_uploads where organization_id in ($1, $2)`, [rotary, northstar]);
  await owner.end();
  await closePool();
  vi.unstubAllEnvs();
});

const at = (organizationId: string): SocialOwner => ({ organizationId, userId: paolo });
const account = () => String(17_800_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e9)));

async function connect(o: SocialOwner, accountId = account(), scopedId = account()) {
  return connectInstagram(o, {
    accountId,
    scopedId,
    username: `vwt_${accountId.slice(-5)}`,
    token: `IGAA-secret-${accountId}`,
    expiresAt: new Date(Date.now() + 60 * 86_400_000),
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    agencyGrantId: null,
  });
}

/** A minimal JPEG header: SOI, an APP0 segment, then a baseline frame of this size. */
function jpegOf(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

describe("sealed tokens", () => {
  test("open only with the same key and for the same row", () => {
    const bound = { organizationId: rotary, channel: "instagram", accountId: "1" };
    const sealed = sealToken("IGAA-token", bound);
    expect(sealed).not.toContain("IGAA");
    expect(openToken(sealed, bound)).toBe("IGAA-token");
    expect(() => openToken(sealed, { ...bound, organizationId: northstar })).toThrow();
    expect(() => openToken(sealed, { ...bound, accountId: "2" })).toThrow();
    vi.stubEnv("CHANNEL_TOKEN_KEY", randomBytes(32).toString("base64url"));
    expect(() => openToken(sealed, bound)).toThrow();
  });
});

describe("connections", () => {
  test("store the token sealed, and a business sees only its own", async () => {
    const row = await connect(at(rotary));
    const stored = await owner.query(`select token_ciphertext from social_connections where id = $1`, [row.id]);
    expect(stored.rows[0].token_ciphertext).toMatch(/^v1\./);
    expect(stored.rows[0].token_ciphertext).not.toContain("secret");

    expect((await instagramFor(at(rotary)))?.id).toBe(row.id);
    expect(await instagramFor(at(northstar))).toBeNull();
    expect(await instagramToken(at(rotary), row)).toBe(`IGAA-secret-${row.accountId}`);

    await disconnectInstagram(at(northstar), row.id, null); // another business's id changes nothing
    expect((await instagramFor(at(rotary)))?.id).toBe(row.id);
  });

  test("an account connected to one business cannot be connected to another", async () => {
    const mine = await instagramFor(at(rotary));
    await expect(connect(at(northstar), mine!.accountId)).rejects.toBeInstanceOf(InstagramTakenError);
  });

  test("connecting again replaces the business's account", async () => {
    const before = await instagramFor(at(rotary));
    const after = await connect(at(rotary));
    expect((await instagramFor(at(rotary)))?.id).toBe(after.id);
    const old = await owner.query(`select disconnected_at, token_ciphertext from social_connections where id = $1`, [before!.id]);
    expect(old.rows[0].disconnected_at).not.toBeNull();
    expect(old.rows[0].token_ciphertext).toBeNull();
  });

  test("disconnecting erases the token and is on the record", async () => {
    const row = (await instagramFor(at(rotary)))!;
    await disconnectInstagram(at(rotary), row.id, null);
    expect(await instagramFor(at(rotary))).toBeNull();
    const gone = await owner.query(`select token_ciphertext, token_expires_at from social_connections where id = $1`, [row.id]);
    expect(gone.rows[0]).toEqual({ token_ciphertext: null, token_expires_at: null });
    const audit = await owner.query(
      `select action, target from audit_events where organization_id = $1 and action like 'instagram.%' order by id desc limit 1`,
      [rotary],
    );
    expect(audit.rows[0]).toEqual({ action: "instagram.disconnected", target: `@${row.username}` });
  });

  test("the database refuses a live connection without a token", async () => {
    await expect(
      owner.query(
        `insert into social_connections (organization_id, channel, account_id, scoped_id, username, connected_by) values ($1, 'instagram', 'x', 'y', 'z', $2)`,
        [rotary, paolo],
      ),
    ).rejects.toThrow(/social_connections_token_iff_live/);
  });
});

describe("Meta's notices", () => {
  const secret = "test-app-secret";
  const config = { appId: "1234567890", appSecret: secret };
  const sign = (payload: object, key = secret) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${createHmac("sha256", key).update(body).digest("base64url")}.${body}`;
  };

  test("only a correctly signed notice names anyone", () => {
    expect(verifySignedRequest(config, sign({ algorithm: "HMAC-SHA256", user_id: "42" }))).toBe("42");
    expect(verifySignedRequest(config, sign({ algorithm: "HMAC-SHA256", user_id: "42" }, "wrong"))).toBeNull();
    expect(verifySignedRequest(config, sign({ algorithm: "none", user_id: "42" }))).toBeNull();
    expect(verifySignedRequest(config, "garbage")).toBeNull();
  });

  test("a deauthorize notice ends that account's connection and erases its token", async () => {
    const scoped = account();
    const row = await connect(at(northstar), account(), scoped);
    expect(await revokeInstagram(scoped, "deauthorize")).toBe(1);
    expect(await instagramFor(at(northstar))).toBeNull();
    const gone = await owner.query(`select token_ciphertext from social_connections where id = $1`, [row.id]);
    expect(gone.rows[0].token_ciphertext).toBeNull();
    const audit = await owner.query(
      `select action, actor_user_id from audit_events where organization_id = $1 order by id desc limit 1`,
      [northstar],
    );
    expect(audit.rows[0]).toEqual({ action: "instagram.disconnected_by_deauthorize", actor_user_id: null });
    expect(await revokeInstagram(scoped, "deauthorize")).toBe(0);
  });
});

describe("photos and videos waiting to be posted", () => {
  test("a JPEG's size is read from its own header", () => {
    expect(jpegSize(jpegOf(1440, 1800))).toEqual({ width: 1440, height: 1800 });
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeNull();
    expect(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  const photo = (o: SocialOwner) =>
    recordSocialMedia(o, {
      kind: "photo",
      contentType: "image/jpeg",
      storageKey: newMediaKey(o.organizationId, "image/jpeg"),
      byteSize: 1000,
      width: 1080,
      height: 1080,
      durationMs: null,
      uploadId: null,
      ready: true,
    });

  test("keys are the business's own, and random", () => {
    const a = newMediaKey(rotary, "video/mp4");
    expect(a).toMatch(new RegExp(`^social/${rotary}/[A-Za-z0-9_-]{32}\\.mp4$`));
    expect(newMediaKey(rotary, "video/mp4")).not.toBe(a);
    expect(() => newMediaKey(rotary, "image/png")).toThrow();
  });

  test("belong to the business that uploaded them", async () => {
    const mine = await photo(at(rotary));
    expect((await socialMediaById(at(rotary), mine.id))?.id).toBe(mine.id);
    expect(await socialMediaById(at(northstar), mine.id)).toBeNull();
    expect(await socialMediaFor(at(northstar), [mine.id])).toBeNull();
    expect((await socialMediaFor(at(rotary), [mine.id]))?.map((r) => r.id)).toEqual([mine.id]);
    expect(await deleteSocialMedia(at(northstar), [mine.id])).toEqual([]);
    expect((await deleteSocialMedia(at(rotary), [mine.id])).map((r) => r.storageKey)).toEqual([mine.storageKey]);
  });

  test("a video still arriving cannot be posted until it is whole", async () => {
    const video = await recordSocialMedia(at(rotary), {
      kind: "video",
      contentType: "video/mp4",
      storageKey: newMediaKey(rotary, "video/mp4"),
      byteSize: 20 * 1024 * 1024,
      width: 1080,
      height: 1920,
      durationMs: 12_000,
      uploadId: "upload-1",
      ready: false,
    });
    expect(await socialMediaFor(at(rotary), [video.id])).toBeNull();
    await markSocialMediaReady(at(rotary), video.id);
    const whole = await socialMediaFor(at(rotary), [video.id]);
    expect(whole?.[0]).toMatchObject({ ready: true, uploadId: null });
    await deleteSocialMedia(at(rotary), [video.id]);
  });

  test("the database holds Instagram's limits and the key's shape", async () => {
    const base = { kind: "video" as const, contentType: "video/mp4", width: 1, height: 1, durationMs: 5000, uploadId: null, ready: true };
    await expect(recordSocialMedia(at(rotary), { ...base, storageKey: newMediaKey(rotary, "video/mp4"), byteSize: 301 * 1024 * 1024 })).rejects.toThrow();
    await expect(recordSocialMedia(at(rotary), { ...base, contentType: "video/webm", storageKey: newMediaKey(rotary, "video/mp4"), byteSize: 10 })).rejects.toThrow();
    await expect(recordSocialMedia(at(rotary), { ...base, storageKey: "elsewhere/x.mp4", byteSize: 10 })).rejects.toThrow();
    await expect(recordSocialMedia(at(rotary), { ...base, uploadId: "open", storageKey: newMediaKey(rotary, "video/mp4"), byteSize: 10 })).rejects.toThrow();
  });

  test("expire after a day, and are handed back for the store to delete", async () => {
    const old = await photo(at(rotary));
    await owner.query(`update social_media_uploads set expires_at = now() - interval '1 second' where id = $1`, [old.id]);
    expect(await socialMediaFor(at(rotary), [old.id])).toBeNull();
    expect(await takeExpiredSocialMedia(at(northstar))).toEqual([]);
    expect((await takeExpiredSocialMedia(at(rotary))).map((r) => r.storageKey)).toContain(old.storageKey);
    expect(await socialMediaById(at(rotary), old.id)).toBeNull();
  });

  test("sweeps expired legacy photos only for this business", async () => {
    const ids: string[] = [];
    try {
      for (const [org, expired] of [[rotary, true], [northstar, true], [rotary, false]] as const) {
        const row = await owner.query(`
          insert into social_media (organization_id, uploaded_by, token_hash, content_type, bytes, width, height, expires_at)
          values ($1, $2, $3, 'image/jpeg', $4, 1080, 1080, $5) returning id
        `, [org, paolo, randomBytes(32).toString("hex"), jpegOf(1080, 1080), new Date(Date.now() + (expired ? -1000 : 86_400_000))]);
        ids.push(row.rows[0].id);
      }
      await takeExpiredSocialMedia(at(rotary));
      const remaining = (await owner.query("select id from social_media where id = any($1::uuid[])", [ids])).rows.map((r) => r.id);
      expect(remaining).not.toContain(ids[0]);
      expect(remaining).toContain(ids[1]);
      expect(remaining).toContain(ids[2]);
    } finally {
      await owner.query("delete from social_media where id = any($1::uuid[])", [ids]);
    }
  });
});

describe("the sign-in round trip", () => {
  test("accepts only the state this browser was given, for the same business", () => {
    const { state, cookie } = newIgState(rotary);
    expect(igStateMatches(cookie, state, rotary)).toBe(true);
    expect(igStateMatches(cookie, state, northstar)).toBe(false);
    expect(igStateMatches(cookie, state + "x", rotary)).toBe(false);
    expect(igStateMatches(undefined, state, rotary)).toBe(false);
    expect(igStateMatches(`${randomUUID()}.${rotary}`, state, rotary)).toBe(false);
  });
});
