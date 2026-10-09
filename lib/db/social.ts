import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { DatabaseError } from "pg";
import { db, inOwnerTransaction } from "./connection";
import { socialConnections, socialMedia } from "./schema";
import { writeAudit } from "./audit";
import { InstagramError, openToken, refreshToken, sealToken } from "@/lib/integrations/instagram";

/**
 * A business's Instagram account, and the photos and videos it is about to
 * post (0034 connections, 0035 bucket uploads).
 *
 * Read and written through the owner transaction, so row-level security
 * filters by business underneath. The access token is sealed before it is
 * written and opened only here, bound to the business and the account
 * (lib/integrations/instagram.ts), and erased on disconnect.
 */

export type SocialConnection = typeof socialConnections.$inferSelect;
export type SocialOwner = { organizationId: string; userId: string };

const CHANNEL = "instagram";

export async function instagramFor(owner: SocialOwner): Promise<SocialConnection | null> {
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .select()
      .from(socialConnections)
      .where(and(eq(socialConnections.channel, CHANNEL), isNull(socialConnections.disconnectedAt)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export class InstagramTakenError extends Error {
  constructor() {
    super("That Instagram account is already connected to another business.");
    this.name = "InstagramTakenError";
  }
}

/**
 * Connect an account, replacing the business's current one if there is one
 * (connecting again is how a signed-out connection is mended).
 */
export async function connectInstagram(
  owner: SocialOwner,
  input: {
    accountId: string;
    scopedId: string;
    username: string;
    token: string;
    expiresAt: Date;
    scopes: string[];
    agencyGrantId: string | null;
  },
): Promise<SocialConnection> {
  const tokenCiphertext = sealToken(input.token, {
    organizationId: owner.organizationId,
    channel: CHANNEL,
    accountId: input.accountId,
  });
  try {
    return await inOwnerTransaction(owner.organizationId, owner.userId, async (tx) => {
      await tx
        .update(socialConnections)
        .set({ disconnectedAt: new Date(), tokenCiphertext: null, tokenExpiresAt: null })
        .where(and(eq(socialConnections.channel, CHANNEL), isNull(socialConnections.disconnectedAt)));
      const [row] = await tx
        .insert(socialConnections)
        .values({
          organizationId: owner.organizationId,
          channel: CHANNEL,
          accountId: input.accountId,
          scopedId: input.scopedId,
          username: input.username,
          tokenCiphertext,
          tokenExpiresAt: input.expiresAt,
          scopes: input.scopes,
          connectedBy: owner.userId,
        })
        .returning();
      await writeAudit(tx, [
        {
          organizationId: owner.organizationId,
          actorUserId: owner.userId,
          agencyGrantId: input.agencyGrantId,
          action: "instagram.connected",
          target: `@${input.username}`,
        },
      ]);
      return row;
    });
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    if (cause instanceof DatabaseError && cause.code === "23505") throw new InstagramTakenError();
    throw err;
  }
}

export async function disconnectInstagram(owner: SocialOwner, id: string, agencyGrantId: string | null): Promise<void> {
  await inOwnerTransaction(owner.organizationId, owner.userId, async (tx) => {
    const [row] = await tx
      .update(socialConnections)
      .set({ disconnectedAt: new Date(), tokenCiphertext: null, tokenExpiresAt: null })
      .where(and(eq(socialConnections.id, id), isNull(socialConnections.disconnectedAt)))
      .returning({ username: socialConnections.username });
    if (!row) return;
    await writeAudit(tx, [
      {
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        agencyGrantId,
        action: "instagram.disconnected",
        target: `@${row.username}`,
      },
    ]);
  });
}

/** Instagram extends a token once it is a day old; the portal does it weekly, as it is used. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The connection's token, extended for another 60 days when it was last
 * extended over a week ago. So a connection stays live as long as someone
 * opens the channel or posts at least every 60 days.
 */
export async function instagramToken(owner: SocialOwner, connection: SocialConnection): Promise<string> {
  if (!connection.tokenCiphertext) throw new InstagramError("Instagram is not connected.");
  const bound = { organizationId: owner.organizationId, channel: CHANNEL, accountId: connection.accountId };
  const token = openToken(connection.tokenCiphertext, bound);
  if (Date.now() - connection.tokenRefreshedAt.getTime() < REFRESH_AFTER_MS) return token;
  try {
    const fresh = await refreshToken(token);
    await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
      tx
        .update(socialConnections)
        .set({
          tokenCiphertext: sealToken(fresh.token, bound),
          tokenExpiresAt: fresh.expiresAt,
          tokenRefreshedAt: new Date(),
        })
        .where(and(eq(socialConnections.id, connection.id), isNull(socialConnections.disconnectedAt))),
    );
    return fresh.token;
  } catch (err) {
    // A token Instagram has stopped accepting is the caller's to report; a
    // refresh that merely failed leaves the current token, still good.
    if (err instanceof InstagramError && err.signedOut) throw err;
    return token;
  }
}

/* ------------------------------------------------------------------ */
/* Photos and videos waiting to be posted                               */
/* ------------------------------------------------------------------ */

export type SocialMediaRow = typeof socialMedia.$inferSelect;
export type SocialMediaKind = "photo" | "video";

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "video/mp4": "mp4", "video/quicktime": "mov" };

/** Where a new file goes in the store: under the business, with a random name. */
export function newMediaKey(organizationId: string, contentType: string): string {
  const ext = EXTENSIONS[contentType];
  if (!ext) throw new Error(`No extension for ${contentType}.`);
  return `social/${organizationId}/${randomBytes(24).toString("base64url")}.${ext}`;
}

export async function recordSocialMedia(
  owner: SocialOwner,
  input: {
    kind: SocialMediaKind;
    contentType: string;
    storageKey: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    uploadId: string | null;
    ready: boolean;
  },
): Promise<SocialMediaRow> {
  const [row] = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .insert(socialMedia)
      .values({ organizationId: owner.organizationId, uploadedBy: owner.userId, ...input })
      .returning(),
  );
  return row;
}

/** One of this business's unexpired files, or null. */
export async function socialMediaById(owner: SocialOwner, id: string): Promise<SocialMediaRow | null> {
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx.select().from(socialMedia).where(eq(socialMedia.id, id)).limit(1),
  );
  const row = rows[0];
  return row && row.expiresAt > new Date() ? row : null;
}

export async function markSocialMediaReady(owner: SocialOwner, id: string): Promise<void> {
  await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx.update(socialMedia).set({ ready: true, uploadId: null }).where(eq(socialMedia.id, id)),
  );
}

/** This business's whole, unexpired files for these ids, in the order given; null if any is not. */
export async function socialMediaFor(owner: SocialOwner, ids: string[]): Promise<SocialMediaRow[] | null> {
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx.select().from(socialMedia).where(inArray(socialMedia.id, ids)),
  );
  const now = new Date();
  const byId = new Map(rows.filter((r) => r.ready && r.expiresAt > now).map((r) => [r.id, r]));
  const out = ids.map((id) => byId.get(id));
  return out.every(Boolean) ? (out as SocialMediaRow[]) : null;
}

/** Forget these files; answers with their keys and open uploads, for the store to delete. */
export async function deleteSocialMedia(owner: SocialOwner, ids: string[]): Promise<Pick<SocialMediaRow, "storageKey" | "uploadId">[]> {
  if (ids.length === 0) return [];
  return inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .delete(socialMedia)
      .where(inArray(socialMedia.id, ids))
      .returning({ storageKey: socialMedia.storageKey, uploadId: socialMedia.uploadId }),
  );
}

/** This business's files past their 24 hours: forgotten here, returned for the store to delete. */
export async function takeExpiredSocialMedia(owner: SocialOwner): Promise<Pick<SocialMediaRow, "storageKey" | "uploadId">[]> {
  return inOwnerTransaction(owner.organizationId, owner.userId, async (tx) => {
    // 0034 photos stay usable during rollout; retire them only after their
    // original expiration. The legacy table has the same business RLS policy.
    await tx.execute(sql`delete from social_media where expires_at < now()`);
    return tx
      .delete(socialMedia)
      .where(lt(socialMedia.expiresAt, new Date()))
      .returning({ storageKey: socialMedia.storageKey, uploadId: socialMedia.uploadId });
  });
}

/**
 * Instagram's notice that the person removed the app, or asked for their data
 * to be deleted (0034's social_connection_revoke). The caller has checked the
 * notice's signature. Answers with how many connections were ended.
 */
export async function revokeInstagram(scopedId: string, reason: "deauthorize" | "deletion_request"): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select social_connection_revoke(${CHANNEL}, ${scopedId}, ${reason}) as n`,
  );
  return Number(result.rows[0]?.n ?? 0);
}
