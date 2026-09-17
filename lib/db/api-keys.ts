import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { inAuthenticationTransaction, inTenantTransaction } from "./connection";
import { apiKeys, memberships, organizations, users } from "./schema";

/**
 * Keys for machines.
 *
 * Presenting a key is the machine equivalent of signing in: it produces a scope
 * and then everything downstream is the ordinary path. The key itself carries no
 * powers — it names a company and a service account, and what that account may
 * do is decided by the same policies as for a person.
 */

/**
 * Keys are shown once, at the moment they are minted, and never again.
 *
 * Two parts. The prefix is not a secret: it is stored in clear so a key can be
 * told apart from its siblings in a list, and so one found in a log can be
 * matched to a row and revoked without anybody having to hold the real value.
 * The rest is 32 random bytes and is stored only as its SHA-256.
 *
 * The visible `10xid_live_` marker exists for the secret scanners: GitHub,
 * gitleaks and their like match on a fixed prefix, so a key pasted into a
 * repository is something a machine can spot.
 */
const KEY_PREFIX = "10xid_live_";
const PREFIX_VISIBLE_CHARS = 6;

export type MintedKey = { id: string; prefix: string; secret: string };

function hashKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Create a service account and a key for it, in one transaction.
 *
 * The account is deliberately a real row in `users`: a job filed by Northstar's
 * website then has the same shape as one filed by a person, and needs no second
 * code path anywhere downstream. Its address is on `.invalid`, a domain reserved
 * by RFC 2606 that can never resolve, so no mailbox can exist to receive a
 * sign-in code — and the sign-in route refuses these accounts outright anyway.
 */
export async function mintKey(input: {
  organizationId: string;
  label: string;
  createdBy: string;
}): Promise<MintedKey> {
  const secret = KEY_PREFIX + randomBytes(32).toString("base64url");
  const prefix = secret.slice(0, KEY_PREFIX.length + PREFIX_VISIBLE_CHARS);

  return inTenantTransaction(input.organizationId, false, async (tx) => {
    const [org] = await tx
      .select({ slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);
    if (!org) throw new Error("No such company.");

    // One service account per key, so revoking a key also orphans exactly the
    // work it filed rather than a shared robot identity used by three systems.
    const email = `${org.slug}-${randomBytes(4).toString("hex")}@service.10xid.invalid`;

    const [account] = await tx
      .insert(users)
      .values({
        email,
        fullName: input.label,
        isStaff: false,
        isService: true,
        emailVerifiedAt: null,
      })
      .returning({ id: users.id });

    await tx.insert(memberships).values({
      userId: account.id,
      organizationId: input.organizationId,
      role: "member",
    });

    const [row] = await tx
      .insert(apiKeys)
      .values({
        organizationId: input.organizationId,
        serviceUserId: account.id,
        label: input.label,
        keyHash: hashKey(secret),
        prefix,
        createdBy: input.createdBy,
      })
      .returning({ id: apiKeys.id });

    return { id: row.id, prefix, secret };
  });
}

export type KeyIdentity = {
  keyId: string;
  organizationId: string;
  serviceUserId: string;
  serviceEmail: string;
  label: string;
};

/**
 * Turn a presented key into a scope, or into nothing.
 *
 * Every failure returns null and says nothing further. A caller must not be able
 * to tell a key that never existed from one that was revoked from one belonging
 * to a company they guessed at — all three are the same answer.
 */
export async function identifyKey(
  presented: string,
): Promise<KeyIdentity | null> {
  if (!presented.startsWith(KEY_PREFIX)) return null;

  const hash = hashKey(presented);

  const rows = await inAuthenticationTransaction((tx) =>
    tx
      .select({
        keyId: apiKeys.id,
        keyHash: apiKeys.keyHash,
        organizationId: apiKeys.organizationId,
        serviceUserId: apiKeys.serviceUserId,
        serviceEmail: users.email,
        label: apiKeys.label,
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.serviceUserId))
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;

  // The index lookup above already required an exact match, so this cannot
  // fail. It is here because a hash comparison that short-circuits on the first
  // differing byte is how a lookup becomes a timing oracle, and the next person
  // to change this query should find the constant-time compare already present
  // rather than have to know to add it.
  if (!timingSafeEqual(row.keyHash, hash)) return null;

  return {
    keyId: row.keyId,
    organizationId: row.organizationId,
    serviceUserId: row.serviceUserId,
    serviceEmail: row.serviceEmail,
    label: row.label,
  };
}

/**
 * Record that a key was used.
 *
 * Runs scoped to the company the key was just proved to belong to, so it goes
 * through the ordinary tenant policy rather than the authentication exception —
 * which is SELECT-only and could not perform this write in any case.
 */
export async function touchKey(
  organizationId: string,
  keyId: string,
): Promise<void> {
  await inTenantTransaction(organizationId, false, (tx) =>
    tx
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, keyId)),
  );
}

export type KeyRow = {
  id: string;
  label: string;
  prefix: string;
  organizationId: string;
  organizationName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  jobsFiled: number;
};

/**
 * The keys a session may see — their own company's, or every company's while
 * staff are surveying. Scoped through the same helper as everything else, so
 * this list obeys the tenant policy rather than a filter written out by hand.
 */
export async function listKeys(scope: {
  isStaff: boolean;
  organizationId: string | null;
}): Promise<KeyRow[]> {
  const surveying = scope.isStaff && scope.organizationId === null;

  return inTenantTransaction(scope.organizationId, surveying, (tx) =>
    tx
      .select({
        id: apiKeys.id,
        label: apiKeys.label,
        prefix: apiKeys.prefix,
        organizationId: apiKeys.organizationId,
        organizationName: organizations.name,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        jobsFiled: sql<number>`(
          select count(*)::int from jobs
           where jobs.created_by = ${apiKeys.serviceUserId}
        )`,
      })
      .from(apiKeys)
      .innerJoin(organizations, eq(organizations.id, apiKeys.organizationId))
      .orderBy(desc(apiKeys.createdAt)),
  );
}

/**
 * Revoking is a timestamp, not a delete. The jobs a key filed stay attributable
 * to the account that filed them, and the audit trail does not develop a hole
 * where the credential used to be.
 */
export async function revokeKey(
  organizationId: string,
  keyId: string,
): Promise<void> {
  await inTenantTransaction(organizationId, false, (tx) =>
    tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId)),
  );
}

export { KEY_PREFIX };
