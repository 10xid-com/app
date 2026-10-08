import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { SiteTakenError, connectWebsite, disconnectWebsite, websiteFor, type SiteOwner } from "@/lib/db/sites";
import { closePool } from "@/lib/db/connection";

/**
 * Site connections (0027), against a real database as the application role.
 *
 *   a business sees only its own website     another business's row is not there
 *   one live website per business            a second connect is refused
 *   one business per site                    a site connected elsewhere cannot be taken
 *   disconnecting frees it, on the record    and the audit says who did what
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
let rotary = "";
let northstar = "";
let paolo = "";
const live: { o: SiteOwner; id: string }[] = [];

beforeAll(async () => {
  await owner.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'paolo@brandingcentres.test') as paolo
  `);
  ({ rotary, northstar, paolo } = rows[0]);
  expect(rotary, "seed data missing — run npm run db:seed").toBeTruthy();
});

afterAll(async () => {
  for (const c of live) await disconnectWebsite(c.o, c.id, null);
  await owner.end();
  await closePool();
});

const at = (organizationId: string): SiteOwner => ({ organizationId, userId: paolo });
const address = () => `https://site-${randomUUID().slice(0, 8)}.example.com`;

async function connect(o: SiteOwner, siteUrl = address()) {
  const row = await connectWebsite(o, { siteUrl, repositoryId: null, agencyGrantId: null });
  live.push({ o, id: row.id });
  return row;
}

describe("site connections", () => {
  test("a business sees its own website and not another's", async () => {
    const row = await connect(at(rotary));
    expect((await websiteFor(at(rotary)))?.id).toBe(row.id);
    expect(await websiteFor(at(northstar))).toBeNull();

    await disconnectWebsite(at(northstar), row.id, null); // another business's id changes nothing
    expect((await websiteFor(at(rotary)))?.id).toBe(row.id);
  });

  test("one live website per business", async () => {
    await expect(connect(at(rotary))).rejects.toBeInstanceOf(SiteTakenError);
  });

  test("a site connected to one business cannot be taken by another", async () => {
    const mine = await websiteFor(at(rotary));
    await expect(connect(at(northstar), mine!.siteUrl)).rejects.toBeInstanceOf(SiteTakenError);
  });

  test("the database refuses an address that is not an https origin", async () => {
    await expect(connect(at(northstar), "http://plain.example.com")).rejects.toThrow();
    await expect(connect(at(northstar), "https://example.com/path")).rejects.toThrow();
  });

  test("disconnecting frees the site, and both ends are on the record", async () => {
    const row = (await websiteFor(at(rotary)))!;
    await disconnectWebsite(at(rotary), row.id, null);
    live.splice(live.findIndex((c) => c.id === row.id), 1);
    expect(await websiteFor(at(rotary))).toBeNull();

    const again = await connect(at(northstar), row.siteUrl);
    expect(again.organizationId).toBe(northstar);

    const { rows } = await owner.query(
      `select action from audit_events where organization_id = $1 and target = $2 order by id`,
      [rotary, row.siteUrl],
    );
    expect(rows.map((r) => r.action)).toEqual(["site.connected", "site.disconnected"]);
  });
});
