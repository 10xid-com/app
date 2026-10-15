import "server-only";
import { z } from "zod";
import { siteOriginFrom, siteRequest, SiteError } from "./client";
import type { SiteActor } from "./sign";
import { copyTargets, recordCopyFailure, replaceCopy, type CopyRecords, type CopyTarget } from "@/lib/db/site-copy";

/**
 * The scheduled website copy (login's 0038). For every live website
 * connection: fetch the site's signed export (/api/10xid/export/), check it,
 * and replace that business's copy with it. The website stays the master
 * copy; this only reads it.
 *
 * It acts for no one person, so it signs as the copy itself, with no rights:
 * the export is the one route a site answers for any signed request, and
 * every other signed route still asks for a person's rights.
 *
 * One site failing does not stop the rest, and leaves that business's last
 * good copy in place with the reason it is not newer (site_copies.error).
 */

export const COPY_PATH = "/api/10xid/export/";

export const copyActor = (business: string): SiteActor => ({
  email: "website-copy@10xid.com",
  name: "10XiD website copy",
  role: "system",
  business,
  can: [],
});

// What one export may hold of each kind; the site caps at the same number.
const MAX = 5000;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? null);
const int = z
  .number()
  .int()
  .nullish()
  .transform((v) => v ?? null);
const num = z
  .number()
  .finite()
  .nullish()
  .transform((v) => v ?? null);
const id = z.number().int().positive();

const exportSchema = z.object({
  version: z.literal(1),
  site: z.string(),
  generatedAt: z.iso.datetime(),
  jobs: z
    .array(
      z.object({
        id,
        created_at: text(40),
        updated_at: text(40),
        quote_id: int,
        customer_name: z.string().min(1).max(500),
        email: text(500),
        phone: text(100),
        vehicle: text(500),
        service: text(500),
        description: text(20000),
        status: z.string().max(40),
        start_date: text(40),
        due_date: text(40),
        price_cents: int,
        deposit_cents: int,
        assigned_to: text(200),
        notes: text(20000),
        completed_at: text(40),
        client_id: int,
        posted_at: text(40),
        post_id: int,
        post_skipped: z.boolean(),
      }),
    )
    .max(MAX),
  clients: z
    .array(
      z.object({
        id,
        created_at: text(40),
        updated_at: text(40),
        name: z.string().min(1).max(500),
        business: text(500),
        email: text(500),
        phone: text(100),
        handle: text(500),
        may_feature: z.boolean(),
        notes: text(20000),
      }),
    )
    .max(MAX),
  materials: z
    .array(
      z.object({
        id,
        created_at: text(40),
        updated_at: text(40),
        kind: z.enum(["vinyl", "laminate"]),
        type: z.enum(["colour", "printable", "ppf"]).nullish().transform((v) => v ?? null),
        brand: z.string().min(1).max(200),
        product: z.string().min(1).max(200),
        code: text(200),
        colour: text(200),
        finish: text(200),
        width_in: num,
        unit: z.enum(["ft", "m", "roll", "sheet"]),
        reorder_at: num,
        active: z.boolean(),
        notes: text(20000),
      }),
    )
    .max(MAX),
  stockMoves: z
    .array(
      z.object({
        id,
        created_at: text(40),
        created_by: text(200),
        material_id: id,
        qty: z.number().finite(),
        reason: z.enum(["received", "used", "adjusted"]),
        job_id: int,
        note: text(2000),
      }),
    )
    .max(MAX),
  posts: z
    .array(
      z.object({
        id,
        slug: z.string().min(1).max(500),
        title: z.string().max(500),
        status: z.string().max(40),
        published_at: text(40),
        updated_at: text(40),
        kind: z.enum(["post", "project"]),
        stage_only: z.boolean(),
        url: z.url({ protocol: /^https?$/ }).max(1000),
        socials: z
          .array(
            z.object({
              channel: z.string().max(40),
              url: z.url({ protocol: /^https$/ }).max(1000),
              linked: z.boolean(),
            }),
          )
          .max(20),
      }),
    )
    .max(MAX),
  socialProfiles: z
    .array(z.object({ channel: z.string().max(40), url: z.url({ protocol: /^https$/ }).max(1000) }))
    .max(50),
});

/**
 * A site's answer as the records to copy, or a SiteError saying why not. The
 * export must say it is from the site it was fetched from: an answer about
 * another site is never filed under this one.
 */
export function readExport(target: CopyTarget, body: unknown): CopyRecords {
  const parsed = exportSchema.safeParse(body);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") || "the answer";
    throw new SiteError(`The site's export could not be read (${where}).`);
  }
  const x = parsed.data;
  if (siteOriginFrom(x.site) !== siteOriginFrom(target.siteUrl)) {
    throw new SiteError(`The export says it is from ${x.site}, not ${target.siteUrl}.`);
  }
  return {
    generatedAt: new Date(x.generatedAt),
    clients: x.clients.map((c) => ({
      sourceId: c.id,
      name: c.name,
      business: c.business,
      email: c.email,
      phone: c.phone,
      handle: c.handle,
      mayFeature: c.may_feature,
      notes: c.notes,
      createdOnSite: c.created_at,
      updatedOnSite: c.updated_at,
    })),
    materials: x.materials.map((m) => ({
      sourceId: m.id,
      kind: m.kind,
      type: m.type,
      brand: m.brand,
      product: m.product,
      code: m.code,
      colour: m.colour,
      finish: m.finish,
      widthIn: m.width_in,
      unit: m.unit,
      reorderAt: m.reorder_at,
      active: m.active,
      notes: m.notes,
      createdOnSite: m.created_at,
      updatedOnSite: m.updated_at,
    })),
    stockMoves: x.stockMoves.map((s) => ({
      sourceId: s.id,
      materialSourceId: s.material_id,
      qty: s.qty,
      reason: s.reason,
      jobSourceId: s.job_id,
      note: s.note,
      createdBy: s.created_by,
      createdOnSite: s.created_at,
    })),
    jobs: x.jobs.map((j) => ({
      sourceId: j.id,
      quoteSourceId: j.quote_id,
      customerName: j.customer_name,
      email: j.email,
      phone: j.phone,
      vehicle: j.vehicle,
      service: j.service,
      description: j.description,
      status: j.status,
      startDate: j.start_date,
      dueDate: j.due_date,
      priceCents: j.price_cents,
      depositCents: j.deposit_cents,
      assignedTo: j.assigned_to,
      notes: j.notes,
      completedAt: j.completed_at,
      clientSourceId: j.client_id,
      postedAt: j.posted_at,
      postSourceId: j.post_id,
      postSkipped: j.post_skipped,
      createdOnSite: j.created_at,
      updatedOnSite: j.updated_at,
    })),
    posts: x.posts.map((p) => ({
      sourceId: p.id,
      kind: p.kind,
      slug: p.slug,
      title: p.title,
      status: p.status,
      url: p.url,
      publishedAt: p.published_at,
      updatedOnSite: p.updated_at,
      stageOnly: p.stage_only,
    })),
    socialPosts: x.posts.flatMap((p) =>
      p.socials.map((s, position) => ({ postSourceId: p.id, position, channel: s.channel, url: s.url, linked: s.linked })),
    ),
    socialProfiles: x.socialProfiles.map((s, position) => ({ position, channel: s.channel, url: s.url })),
  };
}

async function fetchExport(target: CopyTarget): Promise<unknown> {
  const r = await siteRequest({ siteUrl: target.siteUrl, actor: copyActor(target.business), method: "GET", path: COPY_PATH });
  if (r.status !== 200) {
    const said = typeof r.body.error === "string" ? r.body.error : `answered ${r.status}`;
    throw new SiteError(`The site ${said.replace(/\.$/, "")}.`, r.status);
  }
  return r.body;
}

export type CopyRun = { sites: number; copied: number; failed: number; errors: { site: string; error: string }[] };

/** Copy every live website. The steps are passed in so a test can stand in for the network. */
export async function runSiteCopy(
  steps = { targets: copyTargets, fetch: fetchExport, replace: replaceCopy, fail: recordCopyFailure },
): Promise<CopyRun> {
  const targets = await steps.targets();
  const run: CopyRun = { sites: targets.length, copied: 0, failed: 0, errors: [] };
  for (const target of targets) {
    try {
      await steps.replace(target, readExport(target, await steps.fetch(target)));
      run.copied++;
    } catch (e) {
      const error = e instanceof SiteError ? e.message : "The copy could not be saved.";
      if (!(e instanceof SiteError)) console.error("[site-copy]", target.siteUrl, e);
      run.failed++;
      run.errors.push({ site: target.siteUrl, error });
      await steps.fail(target, error).catch((f) => console.error("[site-copy] could not record the failure", f));
    }
  }
  return run;
}
