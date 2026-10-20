import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";

/**
 * The login host's sign-in tables (login's 0022) belong to login.10xid.com
 * alone. The portal signs people in itself and never reads them: as its own
 * restricted role, it cannot read or write any of them.
 */

const app = new Client({ connectionString: process.env.DATABASE_APP_URL });

beforeAll(async () => {
  await app.connect();
});

afterAll(async () => {
  await app.end();
});

describe("the boundary", () => {
  test("the portal's role cannot read or write any sign-in table", async () => {
    for (const table of ["auth_users", "auth_sessions", "auth_accounts", "auth_two_factors", "auth_verifications", "auth_rate_limits"]) {
      await expect(app.query(`select 1 from ${table} limit 1`), table).rejects.toThrow(/permission denied/);
    }
    await expect(app.query("delete from auth_sessions")).rejects.toThrow(/permission denied/);
  });
});
