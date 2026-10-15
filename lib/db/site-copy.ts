import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db, inTenantTransaction, type Transaction } from "./connection";
import {
  siteClients,
  siteCopies,
  siteJobs,
  siteMaterials,
  sitePosts,
  siteSocialPosts,
  siteSocialProfiles,
  siteStockMoves,
} from "./schema";
import type { Scope } from "./index";

/**
 * The website copy (login's 0038): a read-only copy of each business's website
 * records. The website is the master copy; lib/sites/site-copy.ts fetches its
 * signed export on a schedule and replaceCopy() swaps the business's copy for
 * it whole. Nothing in the portal edits these rows.
 *
 * Every write runs in the business's own tenant transaction, so row-level
 * security holds a copy to the business it belongs to, and the composite
 * reference holds it to that business's own website connection.
 */

export type CopyTarget = {
  organizationId: string;
  siteConnectionId: string;
  siteUrl: string;
  business: string;
};

/** The live website connections: the one read made without a business scope. */
export async function copyTargets(): Promise<CopyTarget[]> {
  const { rows } = await db.execute<{
    organization_id: string;
    site_connection_id: string;
    site_url: string;
    business: string;
  }>(sql`select organization_id, site_connection_id, site_url, business from site_copy_targets()`);
  return rows.map((r) => ({
    organizationId: r.organization_id,
    siteConnectionId: r.site_connection_id,
    siteUrl: r.site_url,
    business: r.business,
  }));
}

/** The records of one export, already checked (lib/sites/site-copy.ts readExport). */
export type CopyRecords = {
  generatedAt: Date;
  clients: Omit<typeof siteClients.$inferInsert, "siteConnectionId" | "organizationId">[];
  materials: Omit<typeof siteMaterials.$inferInsert, "siteConnectionId" | "organizationId">[];
  stockMoves: Omit<typeof siteStockMoves.$inferInsert, "siteConnectionId" | "organizationId">[];
  jobs: Omit<typeof siteJobs.$inferInsert, "siteConnectionId" | "organizationId">[];
  posts: Omit<typeof sitePosts.$inferInsert, "siteConnectionId" | "organizationId">[];
  socialPosts: Omit<typeof siteSocialPosts.$inferInsert, "siteConnectionId" | "organizationId">[];
  socialProfiles: Omit<typeof siteSocialProfiles.$inferInsert, "siteConnectionId" | "organizationId">[];
};

const RECORD_TABLES = [siteSocialPosts, siteSocialProfiles, sitePosts, siteStockMoves, siteMaterials, siteJobs, siteClients] as const;

// Inserted in batches, well under Postgres's 65535 parameters a statement.
const BATCH = 500;

async function insertAll<T extends Record<string, unknown>>(
  tx: Transaction,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  target: CopyTarget,
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({
      ...r,
      siteConnectionId: target.siteConnectionId,
      organizationId: target.organizationId,
    }));
    await tx.insert(table).values(batch);
  }
}

/** Swap the business's copy of one website for these records, in one transaction. */
export async function replaceCopy(target: CopyTarget, records: CopyRecords, now = new Date()): Promise<Record<string, number>> {
  const counts = {
    jobs: records.jobs.length,
    clients: records.clients.length,
    materials: records.materials.length,
    stockMoves: records.stockMoves.length,
    posts: records.posts.length,
    socialPosts: records.socialPosts.length,
    socialProfiles: records.socialProfiles.length,
  };
  await inTenantTransaction(target.organizationId, false, async (tx) => {
    for (const table of RECORD_TABLES) {
      await tx.delete(table).where(eq(table.siteConnectionId, target.siteConnectionId));
    }
    await insertAll(tx, siteClients, target, records.clients);
    await insertAll(tx, siteMaterials, target, records.materials);
    await insertAll(tx, siteStockMoves, target, records.stockMoves);
    await insertAll(tx, siteJobs, target, records.jobs);
    await insertAll(tx, sitePosts, target, records.posts);
    await insertAll(tx, siteSocialPosts, target, records.socialPosts);
    await insertAll(tx, siteSocialProfiles, target, records.socialProfiles);
    const latest = { siteUrl: target.siteUrl, generatedAt: records.generatedAt, copiedAt: now, triedAt: now, error: null, counts };
    await tx
      .insert(siteCopies)
      .values({ siteConnectionId: target.siteConnectionId, organizationId: target.organizationId, ...latest })
      .onConflictDoUpdate({ target: siteCopies.siteConnectionId, set: latest });
  });
  return counts;
}

/** A failed attempt: the copy already held stays, and says why it is not newer. */
export async function recordCopyFailure(target: CopyTarget, error: string, now = new Date()): Promise<void> {
  await inTenantTransaction(target.organizationId, false, async (tx) => {
    await tx
      .insert(siteCopies)
      .values({
        siteConnectionId: target.siteConnectionId,
        organizationId: target.organizationId,
        siteUrl: target.siteUrl,
        triedAt: now,
        error: error.slice(0, 500),
      })
      .onConflictDoUpdate({ target: siteCopies.siteConnectionId, set: { triedAt: now, error: error.slice(0, 500) } });
  });
}

export type WebsiteCopy = {
  copy: typeof siteCopies.$inferSelect;
  jobs: (typeof siteJobs.$inferSelect)[];
  clients: (typeof siteClients.$inferSelect)[];
  materials: ((typeof siteMaterials.$inferSelect) & { onHand: number })[];
  stockMoves: (typeof siteStockMoves.$inferSelect)[];
  posts: ((typeof sitePosts.$inferSelect) & { socials: (typeof siteSocialPosts.$inferSelect)[] })[];
  socialProfiles: (typeof siteSocialProfiles.$inferSelect)[];
};

/**
 * The open business's copy of its website, for the read-only page. Null when
 * no client is open (staff on the overview) or nothing has been copied yet.
 * Only the copy of the business's current website: a past connection's copy
 * stays in the database but is not this page's.
 */
export async function websiteCopyFor(scope: Scope, siteConnectionId: string): Promise<WebsiteCopy | null> {
  if (!scope.organizationId) return null;
  return inTenantTransaction(scope.organizationId, false, async (tx) => {
    const [copy] = await tx.select().from(siteCopies).where(eq(siteCopies.siteConnectionId, siteConnectionId)).limit(1);
    if (!copy) return null;
    const id = siteConnectionId;
    const jobs = await tx.select().from(siteJobs).where(eq(siteJobs.siteConnectionId, id)).orderBy(asc(siteJobs.sourceId));
    const clients = await tx.select().from(siteClients).where(eq(siteClients.siteConnectionId, id)).orderBy(asc(siteClients.name));
    const materials = await tx
      .select()
      .from(siteMaterials)
      .where(eq(siteMaterials.siteConnectionId, id))
      .orderBy(asc(siteMaterials.kind), asc(siteMaterials.brand), asc(siteMaterials.product));
    const stockMoves = await tx.select().from(siteStockMoves).where(eq(siteStockMoves.siteConnectionId, id)).orderBy(asc(siteStockMoves.sourceId));
    const posts = await tx.select().from(sitePosts).where(eq(sitePosts.siteConnectionId, id)).orderBy(asc(sitePosts.sourceId));
    const socials = await tx
      .select()
      .from(siteSocialPosts)
      .where(eq(siteSocialPosts.siteConnectionId, id))
      .orderBy(asc(siteSocialPosts.postSourceId), asc(siteSocialPosts.position));
    const socialProfiles = await tx
      .select()
      .from(siteSocialProfiles)
      .where(eq(siteSocialProfiles.siteConnectionId, id))
      .orderBy(asc(siteSocialProfiles.position));
    const onHand = new Map<number, number>();
    for (const m of stockMoves) onHand.set(m.materialSourceId, (onHand.get(m.materialSourceId) ?? 0) + Number(m.qty));
    return {
      copy,
      jobs,
      clients,
      materials: materials.map((m) => ({ ...m, onHand: Math.round((onHand.get(m.sourceId) ?? 0) * 100) / 100 })),
      stockMoves,
      posts: posts.map((p) => ({ ...p, socials: socials.filter((s) => s.postSourceId === p.sourceId) })),
      socialProfiles,
    };
  });
}
