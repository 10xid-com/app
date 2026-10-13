import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { closePool } from "@/lib/db/connection";
import { revokeAuthSession, revokeAuthUserSessions, touchAuthSession } from "@/lib/db/auth-session";

/**
 * The portal's three windows onto a sign-in session on the login host (0022),
 * as the portal's own restricted role. It may ask whether a sign-in is live,
 * and end one; it may not read any of the sign-in tables.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const app = new Client({ connectionString: process.env.DATABASE_APP_URL });
const TAG = `as${Date.now().toString(36)}`;
const userId = `user-${TAG}`;

async function session(opts: { verified: boolean }) {
  const id = randomUUID();
  await owner.query(
    `insert into auth_sessions (id, token, user_id, expires_at) values ($1, $2, $3, now() + interval '30 days')`,
    [id, `token-${id}`, userId],
  );
  if (opts.verified) await owner.query("update auth_sessions set mfa_verified_at = now() where id = $1", [id]);
  return id;
}

beforeAll(async () => {
  await owner.connect();
  await app.connect();
  await owner.query("insert into auth_users (id, name, email) values ($1, 'T', $2)", [userId, `${TAG}@test.invalid`]);
});

afterAll(async () => {
  await owner.query("delete from auth_users where id = $1", [userId]);
  await owner.end();
  await app.end();
  await closePool();
});

describe("auth_session_touch", () => {
  /** Rewrite a session's clocks as an operator would, past the triggers. */
  async function backdate(id: string, set: string) {
    await owner.query("begin");
    await owner.query("set local session_replication_role = replica");
    await owner.query(`update auth_sessions set ${set} where id = $1`, [id]);
    await owner.query("commit");
  }

  test("a live sign-in past the authenticator: its end, moved 400 days out once it is used again", async () => {
    const id = await session({ verified: true });
    // Touched within the minute: the end stands as written.
    const end = await touchAuthSession(id);
    expect(end).toBeInstanceOf(Date);
    expect(end!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 1000);

    // Used again later: signed in until signed out, 400 days at a time (login's 0037).
    await backdate(id, "last_active_at = now() - interval '2 days'");
    const moved = await touchAuthSession(id);
    expect(moved!.getTime()).toBeLessThanOrEqual(Date.now() + 400 * 86_400_000 + 1000);
    expect(moved!.getTime()).toBeGreaterThan(Date.now() + 400 * 86_400_000 - 60_000);
  });

  test("not past the authenticator, unknown, or past its end: nothing. Idle is not an end", async () => {
    expect(await touchAuthSession(await session({ verified: false }))).toBeNull();
    expect(await touchAuthSession("no-such-session")).toBeNull();
    const idle = await session({ verified: true });
    await backdate(idle, "last_active_at = now() - interval '30 days'");
    expect(await touchAuthSession(idle)).toBeInstanceOf(Date);
    const ended = await session({ verified: true });
    await backdate(ended, "expires_at = now() - interval '1 minute'");
    expect(await touchAuthSession(ended)).toBeNull();
  });
});

describe("revocation", () => {
  test("one sign-in, then all of an identity's", async () => {
    const a = await session({ verified: true });
    const b = await session({ verified: true });
    await revokeAuthSession(a);
    expect(await touchAuthSession(a)).toBeNull();
    expect(await touchAuthSession(b)).toBeInstanceOf(Date);
    expect(await revokeAuthUserSessions(userId)).toBeGreaterThanOrEqual(1);
    expect(await touchAuthSession(b)).toBeNull();
  });
});

describe("the boundary", () => {
  test("the portal's role cannot read or write any sign-in table", async () => {
    for (const table of ["auth_users", "auth_sessions", "auth_accounts", "auth_two_factors", "auth_verifications", "auth_rate_limits"]) {
      await expect(app.query(`select 1 from ${table} limit 1`), table).rejects.toThrow(/permission denied/);
    }
    await expect(app.query("delete from auth_sessions")).rejects.toThrow(/permission denied/);
  });
});
