import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./connection";
import { identityBindings, users } from "./schema";

/**
 * WorkOS user id → local account.
 *
 * Like the rest of lib/db/identity.ts these are not tenant-scoped: they are
 * what PRODUCES a scope. `users` and `identity_bindings` carry no organization
 * id, which is why scripts/check-rls.ts does not ask them for a policy.
 */

/** The live account bound to this WorkOS user, if any. */
export async function userByWorkosId(workosUserId: string) {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.workosUserId, workosUserId),
        isNull(users.deletedAt),
        eq(users.isService, false),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The request still waiting for an operator, for this WorkOS user. */
export async function openBindingFor(workosUserId: string) {
  const rows = await db
    .select()
    .from(identityBindings)
    .where(
      and(
        eq(identityBindings.workosUserId, workosUserId),
        isNull(identityBindings.decision),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ask an operator to tie an existing account to a WorkOS user.
 *
 * Idempotent: the partial unique indexes allow one open request per account
 * and one per WorkOS user, so signing in again finds the request already
 * there. A conflict with a DIFFERENT open request (the account is already
 * asked for by another WorkOS user, say) is left standing for the operator to
 * see, rather than replaced.
 */
export async function requestBinding(input: {
  userId: string;
  workosUserId: string;
  email: string;
}): Promise<void> {
  await db
    .insert(identityBindings)
    .values({
      userId: input.userId,
      workosUserId: input.workosUserId,
      email: input.email.trim().toLowerCase(),
    })
    .onConflictDoNothing();
}
