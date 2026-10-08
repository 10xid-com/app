import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { DatabaseError } from "pg";
import { inOwnerTransaction } from "./connection";
import { siteConnections } from "./schema";
import { writeAudit } from "./audit";

/**
 * Which website a business runs from the Website channel (0028).
 *
 * Read and written through the owner transaction, so row-level security
 * filters by business underneath: another business's connection is simply not
 * there. The two unique indexes (one live connection per address across every
 * business, one per business) hold even though neither business can see the
 * other's row.
 */

export type SiteConnection = typeof siteConnections.$inferSelect;

export type SiteOwner = { organizationId: string; userId: string };

export async function websiteFor(owner: SiteOwner): Promise<SiteConnection | null> {
  const rows = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    tx
      .select()
      .from(siteConnections)
      .where(and(eq(siteConnections.channel, "website"), isNull(siteConnections.disconnectedAt)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export class SiteTakenError extends Error {
  constructor() {
    super("That site is already connected to a business.");
    this.name = "SiteTakenError";
  }
}

/**
 * Connect the business's website. Replaces nothing: a business with a live
 * connection must disconnect it first, which the caller checks and the
 * per-business unique index enforces.
 */
export async function connectWebsite(
  owner: SiteOwner,
  input: { siteUrl: string; repositoryId: string | null; agencyGrantId: string | null },
): Promise<SiteConnection> {
  try {
    return await inOwnerTransaction(owner.organizationId, owner.userId, async (tx) => {
      const [row] = await tx
        .insert(siteConnections)
        .values({
          organizationId: owner.organizationId,
          channel: "website",
          siteUrl: input.siteUrl,
          repositoryId: input.repositoryId,
          connectedBy: owner.userId,
        })
        .returning();
      await writeAudit(tx, [
        {
          organizationId: owner.organizationId,
          actorUserId: owner.userId,
          agencyGrantId: input.agencyGrantId,
          action: "site.connected",
          target: input.siteUrl,
        },
      ]);
      return row;
    });
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    if (cause instanceof DatabaseError && cause.code === "23505") throw new SiteTakenError();
    throw err;
  }
}

export async function disconnectWebsite(owner: SiteOwner, id: string, agencyGrantId: string | null): Promise<void> {
  await inOwnerTransaction(owner.organizationId, owner.userId, async (tx) => {
    const [row] = await tx
      .update(siteConnections)
      .set({ disconnectedAt: new Date() })
      .where(and(eq(siteConnections.id, id), isNull(siteConnections.disconnectedAt)))
      .returning({ siteUrl: siteConnections.siteUrl });
    if (!row) return;
    await writeAudit(tx, [
      {
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        agencyGrantId,
        action: "site.disconnected",
        target: row.siteUrl,
      },
    ]);
  });
}
