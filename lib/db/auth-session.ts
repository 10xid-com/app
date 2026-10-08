import "server-only";
import { sql } from "drizzle-orm";
import { db } from "./connection";

/**
 * The portal's three windows onto a sign-in session on the login host.
 *
 * The sign-in tables (auth_*) belong to the login host's restricted role,
 * portal_auth; this app connects as portal_app and holds no privilege on any
 * of them. 0022 grants portal_app EXECUTE on three SECURITY DEFINER functions
 * instead, which can say whether a session is live, record activity on it, and
 * end it — and cannot read a token, a password hash or an authenticator
 * secret. These wrap them.
 */

/**
 * If the sign-in session is live (inside its seven days, active within 48
 * hours) and has passed the authenticator: record activity on it and return
 * when it ends at the latest. Otherwise null — it is over.
 */
export async function touchAuthSession(authSessionId: string): Promise<Date | null> {
  const result = await db.execute<{ hard_end: Date | string | null }>(
    sql`select auth_session_touch(${authSessionId}) as hard_end`,
  );
  const value = result.rows[0]?.hard_end ?? null;
  return value === null ? null : new Date(value);
}

/** End one sign-in session (signing out of this browser). */
/**
 * When the sign-in last passed the authenticator, or null if it is not live
 * (login's 0025, auth_session_verified_at). For the 24-hour and five-minute
 * rules in lib/auth/authorize.ts.
 */
export async function authSessionVerifiedAt(authSessionId: string): Promise<Date | null> {
  const result = await db.execute<{ at: Date | string | null }>(
    sql`select auth_session_verified_at(${authSessionId}) as at`,
  );
  const at = result.rows[0]?.at;
  return at ? new Date(at) : null;
}

export async function revokeAuthSession(authSessionId: string): Promise<void> {
  await db.execute(sql`select auth_revoke_session(${authSessionId})`);
}

/** End every sign-in session of one identity (signing out everywhere). */
export async function revokeAuthUserSessions(authUserId: string): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select auth_revoke_user_sessions(${authUserId}) as n`,
  );
  return Number(result.rows[0]?.n ?? 0);
}
