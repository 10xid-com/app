import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";

/**
 * A portal session past the authenticator, written straight into `sessions`
 * as the owner — what signing in (app/auth/actions.ts) leaves behind, without
 * an inbox or an authenticator app. The token is what the browser's cookie
 * would carry.
 */
export async function signedInSession(
  owner: Client,
  userId: string,
  opts: { secondFactorAt?: Date | null; host?: string } = {},
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest();
  const secondFactorAt = opts.secondFactorAt === undefined ? new Date() : opts.secondFactorAt;
  const { rows } = await owner.query(
    `insert into sessions (user_id, token_hash, issued_for_host, idle_seconds, absolute_expires_at, role_at_creation, second_factor_at)
     values ($1, $2, $3, $4, now() + interval '7 days', 'client', $5) returning id`,
    [userId, hash, opts.host ?? "app.test", 48 * 60 * 60, secondFactorAt],
  );
  return { token, sessionId: rows[0].id as string };
}
