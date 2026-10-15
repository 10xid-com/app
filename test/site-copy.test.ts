import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { copyTargets, websiteCopyFor, replaceCopy, recordCopyFailure, type CopyTarget } from "@/lib/db/site-copy";
import { readExport, runSiteCopy } from "@/lib/sites/site-copy";

/**
 * The website copy (login's 0038), against the real database: a run copies
 * each live website into its own business, replaces the copy whole on the
 * next run, keeps the last good copy when a site fails, and refuses an export
 * that is malformed or says it is from another site.
 */

const owner = new Client({ connectionString: process.env.DATABASE_URL });
let rotaryId = "";
let northstarId = "";
let janeId = "";
let rotary: CopyTarget;
let northstar: CopyTarget;
const ROTARY_URL = "https://copy-app-test-rotary.example.com";
const NORTHSTAR_URL = "https://copy-app-test-northstar.example.com";

beforeAll(async () => {
  await owner.connect();
  const { rows } = await owner.query(`
    select
      (select id from organizations where slug = 'rotary')    as rotary,
      (select id from organizations where slug = 'northstar') as northstar,
      (select id from users where email = 'jane@rotary.test')  as jane,
      (select id from users where email = 'sam@northstar.test') as sam
  `);
  ({ rotary: rotaryId, northstar: northstarId, jane: janeId } = rows[0]);
  const made = await owner.query(
    `insert into site_connections (organization_id, site_url, connected_by) values ($1, $3, $5), ($2, $4, $6) returning id, organization_id`,
    [rotaryId, northstarId, ROTARY_URL, NORTHSTAR_URL, janeId, rows[0].sam],
  );
  const conn = (org: string) => made.rows.find((r) => r.organization_id === org).id;
  rotary = { organizationId: rotaryId, siteConnectionId: conn(rotaryId), siteUrl: ROTARY_URL, business: "Rotary" };
  northstar = { organizationId: northstarId, siteConnectionId: conn(northstarId), siteUrl: NORTHSTAR_URL, business: "Northstar" };
});

afterAll(async () => {
  const ids = [rotary.siteConnectionId, northstar.siteConnectionId];
  for (const t of ["site_social_posts", "site_social_profiles", "site_posts", "site_stock_moves", "site_materials", "site_jobs", "site_clients", "site_copies"]) {
    await owner.query(`delete from ${t} where site_connection_id = any($1)`, [ids]);
  }
  await owner.query("delete from site_connections where id = any($1)", [ids]);
  await owner.end();
});

/** An export as the site's /api/10xid/export/ sends it. */
function exportFor(site: string, over: Record<string, unknown> = {}) {
  return {
    version: 1,
    site,
    generatedAt: "2026-10-15T12:00:00.000Z",
    jobs: [
      { id: 7, created_at: "2026-10-10 10:00:00", updated_at: "2026-10-10 10:00:00", quote_id: null, customer_name: "Hungarock Fleet",
        email: "fleet@hungarock.example", phone: null, vehicle: "2022 Chevy Silverado", service: "Full wrap", description: null,
        status: "completed", start_date: null, due_date: null, price_cents: 450000, deposit_cents: null, assigned_to: null, notes: null,
        completed_at: "2026-10-10", client_id: 3, posted_at: "2026-10-12 09:00:00", post_id: 11, post_skipped: false },
    ],
    clients: [{ id: 3, created_at: null, updated_at: null, name: "Imre", business: "Hungarock Fleet", email: null, phone: null, handle: "@hungarock", may_feature: true, notes: null }],
    materials: [
      { id: 1, created_at: null, updated_at: null, kind: "vinyl", type: "colour", brand: "3M", product: "2080", code: "S12", colour: "Black",
        finish: "Satin", width_in: 60, unit: "ft", reorder_at: 40, active: true, notes: null },
    ],
    stockMoves: [
      { id: 1, created_at: null, created_by: null, material_id: 1, qty: 100, reason: "received", job_id: null, note: null },
      { id: 2, created_at: null, created_by: null, material_id: 1, qty: -65, reason: "used", job_id: 7, note: null },
    ],
    posts: [
      { id: 11, slug: "silverado-full-wrap", title: "Silverado full wrap", status: "published", published_at: "2026-10-12", updated_at: null,
        kind: "post", stage_only: false, url: `${site}/silverado-full-wrap/`,
        socials: [
          { channel: "instagram", url: "https://www.instagram.com/p/ABC123/", linked: true },
          { channel: "facebook", url: "https://www.facebook.com/vinylwrapto/", linked: false },
        ] },
    ],
    socialProfiles: [{ channel: "instagram", url: "https://www.instagram.com/vinylwraptoronto/" }],
    ...over,
  };
}

const scopeOf = (org: string) => ({ userId: janeId, email: "jane@rotary.test", isStaff: false, organizationId: org });
const ours = async () => (await copyTargets()).filter((t) => [rotary.siteConnectionId, northstar.siteConnectionId].includes(t.siteConnectionId));

describe("the website copy", () => {
  test("copyTargets lists the live website connections without a business scope", async () => {
    expect((await ours()).map((t) => t.siteUrl).sort()).toEqual([NORTHSTAR_URL, ROTARY_URL]);
  });

  test("a run copies each website into its own business; another business sees none of it", async () => {
    const run = await runSiteCopy({
      targets: ours,
      fetch: async (t) => exportFor(t.siteUrl),
      replace: replaceCopy,
      fail: recordCopyFailure,
    });
    expect(run).toEqual({ sites: 2, copied: 2, failed: 0, errors: [] });

    const copy = await websiteCopyFor(scopeOf(rotaryId), rotary.siteConnectionId);
    expect(copy?.copy.counts).toEqual({ jobs: 1, clients: 1, materials: 1, stockMoves: 2, posts: 1, socialPosts: 2, socialProfiles: 1 });
    expect(copy?.copy.error).toBeNull();
    expect(copy?.jobs[0]).toMatchObject({ sourceId: 7, customerName: "Hungarock Fleet", clientSourceId: 3, postSourceId: 11, postSkipped: false });
    expect(copy?.materials[0]).toMatchObject({ brand: "3M", onHand: 35, reorderAt: 40 });
    expect(copy?.posts[0].socials.map((s) => [s.channel, s.linked])).toEqual([["instagram", true], ["facebook", false]]);

    // Northstar, asking for Rotary's connection, gets nothing: row-level security.
    expect(await websiteCopyFor(scopeOf(northstarId), rotary.siteConnectionId)).toBeNull();
    // No business open (staff on the overview): nothing.
    expect(await websiteCopyFor({ ...scopeOf(rotaryId), organizationId: null }, rotary.siteConnectionId)).toBeNull();
  });

  test("the next run replaces the copy whole", async () => {
    await runSiteCopy({
      targets: async () => [rotary],
      fetch: async (t) => exportFor(t.siteUrl, { clients: [], stockMoves: [] }),
      replace: replaceCopy,
      fail: recordCopyFailure,
    });
    const copy = await websiteCopyFor(scopeOf(rotaryId), rotary.siteConnectionId);
    expect(copy?.clients).toEqual([]);
    expect(copy?.materials[0].onHand).toBe(0);
  });

  test("a site that fails keeps its last good copy, and says why it is not newer", async () => {
    const run = await runSiteCopy({
      targets: async () => [rotary, northstar],
      fetch: async (t) => {
        if (t === rotary) throw new (await import("@/lib/sites/client")).SiteError("copy-app-test-rotary.example.com did not answer.");
        return exportFor(t.siteUrl);
      },
      replace: replaceCopy,
      fail: recordCopyFailure,
    });
    expect(run.copied).toBe(1);
    expect(run.errors).toEqual([{ site: ROTARY_URL, error: "copy-app-test-rotary.example.com did not answer." }]);
    const copy = await websiteCopyFor(scopeOf(rotaryId), rotary.siteConnectionId);
    expect(copy?.copy.error).toBe("copy-app-test-rotary.example.com did not answer.");
    expect(copy?.jobs).toHaveLength(1);
  });

  test("an export that is malformed, or from another site, is refused", () => {
    expect(() => readExport(rotary, exportFor(NORTHSTAR_URL))).toThrow(/not https:\/\/copy-app-test-rotary/);
    expect(() => readExport(rotary, { ...exportFor(ROTARY_URL), version: 2 })).toThrow(/could not be read \(version\)/);
    expect(() => readExport(rotary, exportFor(ROTARY_URL, { jobs: [{ id: "x" }] }))).toThrow(/could not be read \(jobs\.0\.id\)/);
    const bad = exportFor(ROTARY_URL);
    bad.posts[0].socials[0].url = "javascript:alert(1)";
    expect(() => readExport(rotary, bad)).toThrow(/could not be read \(posts\.0\.socials\.0\.url\)/);
  });
});
