import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { DatabaseError } from "pg";
import { db, inOwnerTransaction } from "./connection";
import { socialConnections, socialMedia } from "./schema";
import { writeAudit } from "./audit";
import { InstagramError, openToken, refreshToken, sealToken } from "@/lib/integrations/instagram";

/**
 * A business's Instagram account, and the photos it is about to post (0034).
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
/* Photos waiting to be posted                                          */
/* ------------------------------------------------------------------ */

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Keep a JPEG for Instagram to fetch; answers with the token for its public address. */
export async function saveSocialPhoto(
  owner: SocialOwner,
  input: { bytes: Buffer; width: number; height: number },
): Promise<{ token: string }> {
  const token = randomBytes(32).toString("base64url");
  await inOwnerTransaction(owner.organizationId, owner.userId, async (tx) => {
    // This business's leftovers from abandoned posts, while we are here.
    await tx.delete(socialMedia).where(lt(socialMedia.expiresAt, new Date()));
    await tx.insert(socialMedia).values({
      organizationId: owner.organizationId,
      uploadedBy: owner.userId,
      tokenHash: hashOf(token),
      contentType: "image/jpeg",
      bytes: input.bytes,
      width: input.width,
      height: input.height,
    });
  });
  return { token };
}

/** This business's unexpired photos for these tokens, in the order given; null if any is missing. */
export async function socialPhotosFor(owner: SocialOwner, tokens: string[]): Promise<{ id: string; token: string }[] | null> {
  const hashes = tokens.map(hashOf);
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .select({ id: socialMedia.id, tokenHash: socialMedia.tokenHash, expiresAt: socialMedia.expiresAt })
      .from(socialMedia)
      .where(inArray(socialMedia.tokenHash, hashes)),
  );
  const byHash = new Map(rows.filter((r) => r.expiresAt > new Date()).map((r) => [r.tokenHash, r.id]));
  const out = tokens.map((token, i) => ({ id: byHash.get(hashes[i]) ?? "", token }));
  return out.every((p) => p.id) ? out : null;
}

export async function deleteSocialPhotos(owner: SocialOwner, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx.delete(socialMedia).where(inArray(socialMedia.id, ids)),
  );
}

/** The photo behind a public token, for Instagram's fetch (0034's social_media_public). */
export async function publicSocialPhoto(token: string): Promise<Buffer | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await db.execute<{ content_type: string; bytes: Buffer }>(
    sql`select content_type, bytes from social_media_public(${hashOf(token)})`,
  );
  return result.rows[0]?.bytes ?? null;
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
