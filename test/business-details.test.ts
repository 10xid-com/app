import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { updateBusinessDetails } from "@/lib/db/identity";
import { closePool } from "@/lib/db/connection";

/**
 * /settings writes `organizations`, which has no row-level security, so the
 * one thing keeping a save to its own business is the WHERE on the id the
 * session was authorized for. This holds it to that, and to its audit line.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
const TAG = `bd${Date.now().toString(36)}`;
let mine = "";
let theirs = "";
let janeId = "";

beforeAll(async () => {
  await owner.connect();
  janeId = (await owner.query("select id from users where email = 'jane@rotary.test'")).rows[0]?.id;
  expect(janeId, "seed data missing — run login's db:seed").toBeTruthy();
  const made = await owner.query(
    "insert into organizations (type, name, slug) values ('client', $1, $1), ('client', $2, $2) returning id",
    [`${TAG}-mine`, `${TAG}-theirs`],
  );
  [mine, theirs] = made.rows.map((r) => r.id);
});

afterAll(async () => {
  await owner.end();
  await closePool();
});

const details = { name: "Renamed Co", brandPrimaryHex: "#1d4ed8", brandLogoUrl: "https://example.com/logo.png", memberVisibility: "open" as const };

describe("saving the business's details", () => {
  test("changes that business only, and says what changed in its audit log", async () => {
    const changed = await updateBusinessDetails(mine, { userId: janeId, agencyGrantId: null }, details);
    expect(changed.sort()).toEqual(["brandLogoUrl", "brandPrimaryHex", "memberVisibility", "name"]);

    const rows = (await owner.query("select id, name, brand_primary_hex, member_visibility from organizations where id = any($1)", [[mine, theirs]])).rows;
    expect(rows.find((r) => r.id === mine)).toMatchObject({ name: "Renamed Co", brand_primary_hex: "#1d4ed8", member_visibility: "open" });
    expect(rows.find((r) => r.id === theirs)).toMatchObject({ name: `${TAG}-theirs`, brand_primary_hex: null, member_visibility: "closed" });

    const audit = (await owner.query("select action, target, actor_user_id from audit_events where organization_id = $1", [mine])).rows;
    expect(audit).toEqual([{ action: "business.details_changed", target: expect.stringContaining("name"), actor_user_id: janeId }]);
  });

  test("saving what is already there changes nothing and logs nothing", async () => {
    expect(await updateBusinessDetails(mine, { userId: janeId, agencyGrantId: null }, details)).toEqual([]);
    const n = (await owner.query("select count(*)::int as n from audit_events where organization_id = $1", [mine])).rows[0].n;
    expect(n).toBe(1);
  });
});
