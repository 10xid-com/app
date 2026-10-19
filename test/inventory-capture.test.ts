import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * Cataloguing a container from phone photos, end to end, against the real
 * database as the application role (login's 0048), through the same route
 * handlers and server actions the screens use. The media store, the label
 * reader and the session stand in; nothing here reaches a provider.
 *
 *   a photo                 stored once; a retry, or the same bytes again,
 *                           is the same document; a store failure is finished
 *                           by the retry
 *   saving                  one lot, one container, one opening; saving again
 *                           makes nothing
 *   unknown                 no amount, no date, no price: still saved, as
 *                           unknown, never 0
 *   a second jar            the same label photo is one document, linked to
 *                           both captures and both containers
 *   a weighing              "measured" only from a scale's net with a weighed
 *                           empty container
 *   another business        sees none of it
 *   switched off            every route a 404
 *   the label reader        off unless allowed, nothing sent; a good answer
 *                           kept for review; a bad one a failed reading, and
 *                           saving by hand still works; HEIC never sent
 */

const h = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(readonly url: string) {
      super(`redirect ${url}`);
    }
  }
  class NotFound extends Error {}
  return {
    Redirect,
    NotFound,
    store: new Map<string, Uint8Array>(),
    who: { businessId: "", userId: "", email: "" },
    failNextPut: { value: false },
    /** The next upload to the store waits here, then fails: a slow attempt overtaken by a retry. */
    slowFailingPut: { next: null as null | { reached: () => void; release: Promise<void> } },
  };
});

vi.mock("@/lib/integrations/media-bucket", () => {
  class BucketError extends Error {}
  return {
    BucketError,
    mediaBucketConfigured: () => true,
    putObject: async (key: string, body: Uint8Array) => {
      if (h.failNextPut.value) {
        h.failNextPut.value = false;
        throw new BucketError("The media store did not answer (the upload).");
      }
      const slow = h.slowFailingPut.next;
      if (slow) {
        h.slowFailingPut.next = null;
        slow.reached();
        await slow.release;
        throw new BucketError("The media store did not answer (the upload).");
      }
      h.store.set(key, body);
    },
    getObject: async (key: string) => {
      const b = h.store.get(key);
      if (!b) throw new BucketError("The media store refused a download (404 NoSuchKey).");
      return b;
    },
    deleteObject: async () => {
      throw new Error("Nothing in inventory deletes from the store.");
    },
    isEvidenceKey: (key: string) => key.startsWith("inventory/"),
  };
});

vi.mock("@/lib/auth/authorize", () => {
  const granted = () => ({
    allowed: true as const,
    ctx: { userId: h.who.userId, email: h.who.email, scope: { organizationId: h.who.businessId, isStaff: false } },
    businessId: h.who.businessId,
    role: "owner",
    via: null,
  });
  return { authorizeRequest: async () => granted(), requireAction: async () => granted() };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.Redirect(url);
  },
  notFound: () => {
    throw new h.NotFound();
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const db = new Client({ connectionString: process.env.DATABASE_URL });
const A = { organizationId: "", userId: "", email: "jane@rotary.test" };
const B = { organizationId: "", userId: "", email: "sam@northstar.test" };
const RUN = randomBytes(4).toString("hex");

const INVENTORY_TABLES = [
  "inventory_purchase_intents", "inventory_notes", "inventory_movements", "inventory_batches", "inventory_reservations",
  "inventory_batch_plans", "inventory_formulation_lines", "inventory_formulation_versions", "inventory_offer_prices",
  "inventory_product_claims", "inventory_product_nutrients", "inventory_measurements", "inventory_match_candidates",
  "inventory_extracted_fields", "inventory_extractions", "inventory_document_links", "inventory_documents",
  "inventory_captures", "inventory_containers", "inventory_lots", "inventory_locations", "inventory_receipt_lines",
  "inventory_receipts", "inventory_order_lines", "inventory_orders", "inventory_sourcing_preferences", "inventory_offers",
  "inventory_product_components", "inventory_products", "inventory_formulations", "inventory_brands",
  "inventory_businesses", "inventory_material_aliases", "inventory_materials", "inventory_nutrients",
];

async function clean() {
  await db.query(`truncate table ${INVENTORY_TABLES.join(", ")} cascade`);
  await db.query(
    `delete from identities where organization_id in (select id from organizations where type = 'listed' and name like $1)`,
    [`Test maker ${RUN}%`],
  );
  await db.query(`delete from organizations where type = 'listed' and name like $1`, [`Test maker ${RUN}%`]);
}

beforeAll(async () => {
  await db.connect();
  const { rows } = await db.query(`
    select (select id from organizations where slug = 'rotary') as rotary,
           (select id from users where email = 'jane@rotary.test') as jane,
           (select id from organizations where slug = 'northstar') as northstar,
           (select id from users where email = 'sam@northstar.test') as sam`);
  A.organizationId = rows[0].rotary;
  A.userId = rows[0].jane;
  B.organizationId = rows[0].northstar;
  B.userId = rows[0].sam;
  await clean();
});

beforeEach(() => {
  vi.stubEnv("INVENTORY_BUSINESSES", `${A.organizationId}, ${B.organizationId}`);
  as(A);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await clean();
  await db.end();
  const { closePool } = await import("@/lib/db/connection");
  await closePool();
});

function as(who: typeof A) {
  h.who.businessId = who.organizationId;
  h.who.userId = who.userId;
  h.who.email = who.email;
}

const owner = (who: typeof A) => ({ organizationId: who.organizationId, userId: who.userId });
const jpeg = (seed: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic label ${seed}`)]));
const heic = (seed: string) =>
  new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.from(`synthetic heic ${seed}`)]));
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function newCapture(who = A) {
  const { createCapture } = await import("@/lib/db/inventory");
  return createCapture(owner(who));
}

async function upload(captureId: string, bytes: Uint8Array, opts: { sha256?: string; afterSave?: boolean } = {}) {
  const { POST } = await import("@/app/api/inventory/captures/[id]/photos/route");
  const form = new FormData();
  form.append("photo", new File([Buffer.from(bytes)], "IMG_0001.jpg", { type: "image/jpeg" }));
  form.append("sha256", opts.sha256 ?? hex(bytes));
  if (opts.afterSave) form.append("afterSave", "1");
  const res = await POST(new Request("https://app.example.com/x", { method: "POST", body: form }), {
    params: Promise.resolve({ id: captureId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const START = { error: null, field: null, values: null, at: 0 };

/** Press Save on the review form with these values. */
async function save(captureId: string, values: Record<string, string>) {
  const { saveCaptureAction } = await import("@/app/inventory/actions");
  const form = new FormData();
  form.append("captureId", captureId);
  for (const [k, v] of Object.entries({ product: "new", status: "sealed", amount: "unknown", ...values })) form.append(k, v);
  try {
    const state = await saveCaptureAction(START, form);
    return { state, redirect: null as string | null };
  } catch (err) {
    if (err instanceof h.Redirect) return { state: null, redirect: err.url };
    throw err;
  }
}

const savedContainer = (redirect: string | null) => {
  const m = /^\/inventory\?saved=([0-9a-f-]{36})$/.exec(redirect ?? "");
  if (!m) throw new Error(`not a save: ${redirect}`);
  return m[1];
};

const n = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0].n);

/* ------------------------------------------------------------------ */

describe("a photo", () => {
  test("is stored once under the business, linked to its capture; the same bytes again are the same document", async () => {
    const capture = await newCapture();
    const photo = jpeg(`once-${RUN}`);
    const first = await upload(capture, photo);
    expect(first.status).toBe(200);
    expect(first.body.reused).toBe(false);

    const { rows } = await db.query(`select storage_key, state, content_type from inventory_documents where id = $1`, [first.body.documentId]);
    expect(rows[0].state).toBe("stored");
    expect(rows[0].content_type).toBe("image/jpeg");
    expect(rows[0].storage_key).toMatch(new RegExp(`^inventory/${A.organizationId}/[A-Za-z0-9_-]{32}\\.jpg$`));
    expect(h.store.get(rows[0].storage_key)).toEqual(photo);

    const again = await upload(capture, photo);
    expect(again.status).toBe(200);
    expect(again.body.documentId).toBe(first.body.documentId);
    expect(again.body.reused).toBe(true);
    expect(await n(`select count(*) as n from inventory_documents where organization_id = $1`, [A.organizationId])).toBe(1);
    expect(await n(`select count(*) as n from inventory_document_links where capture_id = $1`, [capture])).toBe(1);
  });

  test("is refused when it is not an image, or not what the phone sent", async () => {
    const capture = await newCapture();
    const pdf = new Uint8Array(Buffer.from("%PDF-1.7 synthetic"));
    expect((await upload(capture, pdf)).status).toBe(415);
    expect((await upload(capture, jpeg(`hash-${RUN}`), { sha256: "0".repeat(64) })).status).toBe(422);
  });

  test("whose store fails is left failed, and the retry finishes it", async () => {
    const capture = await newCapture();
    const photo = jpeg(`flaky-${RUN}`);
    h.failNextPut.value = true;
    const failed = await upload(capture, photo);
    expect(failed.status).toBe(502);
    expect((await db.query(`select state from inventory_documents where sha256 = $1`, [createHash("sha256").update(photo).digest()])).rows[0].state).toBe("failed");
    const retried = await upload(capture, photo);
    expect(retried.status).toBe(200);
    expect((await db.query(`select state from inventory_documents where id = $1`, [retried.body.documentId])).rows[0].state).toBe("stored");
  });
});

describe("saving", () => {
  test("creates exactly one lot, container and opening; saving again creates nothing", async () => {
    const capture = await newCapture();
    const photo = await upload(capture, jpeg(`save-${RUN}`));
    const values = {
      productName: "Test cacao powder",
      brand: `Test brand ${RUN}`,
      manufacturer: `Test maker ${RUN} A`,
      form: "powder",
      single: "on",
      labelQuantity: "500",
      labelUnit: "g",
      lotCode: "L2417A",
      expiryPrinted: "BB 2027 MR 01",
      expiryDate: "2027-03-01",
      expiryKind: "best_before",
      amount: "label",
      location: "Pantry shelf 2",
    };
    const first = await save(capture, values);
    const containerId = savedContainer(first.redirect);

    const q = await db.query(
      `select m.kind, m.basis, m.quantity::text, m.unit, m.idempotency_key, c.status, c.nominal_quantity::text, c.nominal_unit,
              k.status as capture_status, k.outcome, p.name as product, p.composition, b.name as brand, l.lot_code, l.expiry_date::text,
              o.type::text as maker_type, i.id_code
         from inventory_movements m
         join inventory_containers c on c.id = m.container_id
         join inventory_captures k on k.container_id = c.id
         join inventory_lots l on l.id = c.lot_id
         join inventory_products p on p.id = l.product_id
         left join inventory_brands b on b.id = p.brand_id
         left join inventory_businesses mb on mb.id = p.manufacturer_id
         left join organizations o on o.id = mb.company_id
         left join identities i on i.organization_id = o.id and i.revoked_at is null
        where m.container_id = $1`,
      [containerId],
    );
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]).toMatchObject({
      kind: "opening",
      basis: "labelled_unopened",
      quantity: "500.0000",
      unit: "g",
      idempotency_key: `capture:${capture}:opening`,
      status: "sealed",
      nominal_quantity: "500.0000",
      nominal_unit: "g",
      capture_status: "confirmed",
      outcome: "new_container",
      product: "Test cacao powder",
      composition: "single",
      brand: `Test brand ${RUN}`,
      lot_code: "L2417A",
      expiry_date: "2027-03-01",
      maker_type: "listed",
    });
    expect(q.rows[0].id_code).toMatch(/^10X-[0-9A-HJKMNP-TV-Z]{5}$/);
    // The photo is evidence for what was saved.
    expect(
      await n(
        `select count(*) as n from inventory_document_links where document_id = $1 and (container_id = $2 or lot_id is not null or product_id is not null)`,
        [photo.body.documentId, containerId],
      ),
    ).toBe(3);
    // A listed company with an iD is not a member of anything.
    expect(await n(`select count(*) as n from memberships m join organizations o on o.id = m.organization_id where o.type = 'listed'`)).toBe(0);

    const counts = async () => {
      const out: number[] = [];
      for (const t of ["inventory_containers", "inventory_lots", "inventory_movements", "inventory_products"]) {
        out.push(await n(`select count(*) as n from ${t} where organization_id = $1`, [A.organizationId]));
      }
      return out;
    };
    const before = await counts();
    const second = await save(capture, values);
    expect(savedContainer(second.redirect)).toBe(containerId);
    expect(await counts()).toEqual(before);
  });

  test("with no amount, no date and no price still saves, and the amount is unknown, never 0", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`unknown-${RUN}`));
    const saved = await save(capture, { productName: "Test unlabelled jar", status: "open", amount: "unknown" });
    const containerId = savedContainer(saved.redirect);
    const { rows } = await db.query(`select balance, balance_basis from inventory_container_balances where container_id = $1`, [containerId]);
    expect(rows[0]).toEqual({ balance: null, balance_basis: "unknown" });

    const { listInventory } = await import("@/lib/db/inventory");
    const row = (await listInventory(owner(A))).find((r) => r.containerId === containerId)!;
    expect(row.balance).toBeNull();
    expect(row.expiryDate).toBeNull();
  });

  test("refuses an opened package at its label weight, and gives back what was typed", async () => {
    const capture = await newCapture();
    const refused = await save(capture, { productName: "Test opened bag", labelQuantity: "1", labelUnit: "kg", status: "open", amount: "label" });
    expect(refused.redirect).toBeNull();
    expect(refused.state?.field).toBe("amount");
    expect(refused.state?.values?.productName).toBe("Test opened bag");
    expect(await n(`select count(*) as n from inventory_captures where id = $1 and status = 'open'`, [capture])).toBe(1);
  });
});

describe("a photo that has not finished arriving", () => {
  test("stops the item being saved — whatever the screen did — until it arrives or is taken out", async () => {
    const capture = await newCapture();
    // A failed upload: the document is linked to the item, the file never stored.
    const photo = jpeg(`unsent-failed-${RUN}`);
    h.failNextPut.value = true;
    expect((await upload(capture, photo)).status).toBe(502);

    const refused = await save(capture, { productName: "Test saved before its photo", amount: "unknown" });
    expect(refused.redirect).toBeNull();
    expect(refused.state?.error).toMatch(/not finished arriving/);
    expect((await db.query(`select status, container_id from inventory_captures where id = $1`, [capture])).rows[0]).toEqual({
      status: "open",
      container_id: null,
    });

    // The retry from the phone finishes it; then the item saves.
    expect((await upload(capture, photo)).status).toBe(200);
    savedContainer((await save(capture, { productName: "Test saved after its photo", amount: "unknown" })).redirect);
  });

  test("still being stored (another tab, another phone) stops the save too; taking it out lets the item save", async () => {
    const capture = await newCapture();
    const stored = await upload(capture, jpeg(`kept-${RUN}`));
    expect(stored.status).toBe(200);
    // Registered and linked, its upload still under way somewhere else.
    const { registerCapturePhoto } = await import("@/lib/db/inventory");
    const bytes = jpeg(`elsewhere-${RUN}`);
    const pending = await registerCapturePhoto(owner(A), capture, {
      sha256: createHash("sha256").update(bytes).digest(),
      contentType: "image/jpeg",
      byteSize: bytes.length,
      originalName: null,
      capturedAt: null,
      storageKey: `inventory/${A.organizationId}/${randomBytes(24).toString("base64url")}.jpg`,
    });
    expect(pending.state).toBe("pending");
    expect((await save(capture, { productName: "Test saved too early", amount: "unknown" })).state?.error).toMatch(/not finished arriving/);

    const { removePhotoAction } = await import("@/app/inventory/actions");
    const form = new FormData();
    form.append("captureId", capture);
    form.append("documentId", pending.documentId);
    await expect(removePhotoAction(form)).rejects.toThrow(`redirect /inventory/capture/${capture}`);
    expect(await n(`select count(*) as n from inventory_document_links where capture_id = $1`, [capture])).toBe(1);
    // The file's record is kept; only this item no longer counts on it.
    expect(await n(`select count(*) as n from inventory_documents where id = $1`, [pending.documentId])).toBe(1);

    const container = savedContainer((await save(capture, { productName: "Test saved without the stuck photo", amount: "unknown" })).redirect);
    expect(await n(`select count(*) as n from inventory_document_links where container_id = $1`, [container])).toBe(1);
  });

  test("an upload that fails after another has stored the same file never marks it failed", async () => {
    const capture = await newCapture();
    const photo = jpeg(`overtaken-${RUN}`);
    let reached!: () => void;
    const atStore = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    h.slowFailingPut.next = { reached: () => reached(), release: new Promise<void>((resolve) => (release = resolve)) };

    // The first attempt reaches the store and hangs there; the retry overtakes it and stores the file.
    const slow = upload(capture, photo);
    await atStore;
    const retry = await upload(capture, photo);
    expect(retry.status).toBe(200);
    const container = savedContainer((await save(capture, { productName: "Test saved while an upload hung", amount: "unknown" })).redirect);

    // Then the first attempt fails.
    release();
    expect((await slow).status).toBe(502);
    expect((await db.query(`select state from inventory_documents where id = $1`, [retry.body.documentId])).rows[0].state).toBe("stored");
    const { documentForDownload } = await import("@/lib/db/inventory");
    expect(await documentForDownload(owner(A), String(retry.body.documentId))).not.toBeNull();
    expect(await n(`select count(*) as n from inventory_document_links where container_id = $1`, [container])).toBe(1);
  });
});

describe("a photo still on a phone when the item is saved from somewhere else", () => {
  test("is kept by the phone, and added to the saved container as evidence only when the person chooses — once, with the stock untouched", async () => {
    const { uploadOutcome } = await import("@/app/inventory/capture/[id]/photo-queue");
    const capture = await newCapture();
    // Phone A takes a photo with no signal: it exists only in A's queue, nothing is registered.
    const photo = jpeg(`offline-${RUN}`);
    const digest = createHash("sha256").update(photo).digest();
    // Phone B saves the item meanwhile.
    const container = savedContainer((await save(capture, { productName: "Test saved on the other phone", amount: "unknown" })).redirect);
    const stock = async () =>
      (await db.query(
        `select (select count(*)::int from inventory_containers c join inventory_captures k on k.container_id = c.id where k.id = $1) as containers,
                (select count(*)::int from inventory_movements where container_id = $2) as movements`,
        [capture, container],
      )).rows[0];
    const before = await stock();

    // A is back online and its queue sends the photo as usual: refused as saved, and the phone keeps it.
    const plain = await upload(capture, photo);
    expect(plain).toMatchObject({ status: 409, body: { code: "saved" } });
    expect(uploadOutcome(plain.status, plain.body)).toMatchObject({ ok: false, keep: true, retry: false });
    expect(await n(`select count(*) as n from inventory_documents where sha256 = $1`, [digest])).toBe(0);

    // On the saved item's page the person chooses to add it.
    const added = await upload(capture, photo, { afterSave: true });
    expect(added.status).toBe(200);
    expect(added.body.addedToSaved).toBe(container);
    const links = async () =>
      (await db.query(
        `select count(capture_id)::int as captures, count(container_id)::int as containers, count(lot_id)::int as lots, count(product_id)::int as products
           from inventory_document_links where document_id = $1`,
        [added.body.documentId],
      )).rows[0];
    expect(await links()).toEqual({ captures: 1, containers: 1, lots: 1, products: 1 });
    const audit = `select count(*) as n from audit_events where action = 'inventory.evidence.added_after_save' and target = $1`;
    expect(await n(audit, [`inventory_containers:${container}`])).toBe(1);

    // A retry of the same choice: the same document, no new link, no second record of the decision.
    const again = await upload(capture, photo, { afterSave: true });
    expect(again.body.documentId).toBe(added.body.documentId);
    expect(await links()).toEqual({ captures: 1, containers: 1, lots: 1, products: 1 });
    expect(await n(audit, [`inventory_containers:${container}`])).toBe(1);

    // Nothing in the stock changed: no new container, no new stock event.
    expect(await stock()).toEqual(before);
    expect((await db.query(`select status, container_id from inventory_captures where id = $1`, [capture])).rows[0]).toEqual({
      status: "confirmed",
      container_id: container,
    });
  });

  test("for a discarded item is refused, and the phone keeps it for the person to remove", async () => {
    const { uploadOutcome } = await import("@/app/inventory/capture/[id]/photo-queue");
    const capture = await newCapture();
    const { discardCaptureAction } = await import("@/app/inventory/actions");
    const form = new FormData();
    form.append("captureId", capture);
    await expect(discardCaptureAction(form)).rejects.toThrow("redirect /inventory");
    for (const afterSave of [false, true]) {
      const sent = await upload(capture, jpeg(`discarded-${afterSave}-${RUN}`), { afterSave });
      expect(sent).toMatchObject({ status: 409, body: { code: "closed" } });
      expect(uploadOutcome(sent.status, sent.body)).toMatchObject({ ok: false, keep: true });
    }
  });
});

describe("the same label photo for a second jar", () => {
  test("is one document, linked to both captures, and saving makes two containers with one opening each", async () => {
    const photo = jpeg(`two-jars-${RUN}`);
    const first = await newCapture();
    const upA = await upload(first, photo);
    const containerA = savedContainer((await save(first, { productName: "Test spirulina", labelQuantity: "250", labelUnit: "g", amount: "label" })).redirect);

    const second = await newCapture();
    const upB = await upload(second, photo);
    expect(upB.status).toBe(200);
    expect(upB.body.documentId).toBe(upA.body.documentId);
    expect(upB.body.reused).toBe(true);
    expect((upB.body.evidenceFor as { containerId: string }[]).map((e) => e.containerId)).toEqual([containerA]);

    const { getCapture } = await import("@/lib/db/inventory");
    const view = await getCapture(owner(A), second);
    expect(view!.photos.map((p) => p.id)).toEqual([upA.body.documentId]);
    expect(view!.photos[0].evidenceFor.map((e) => e.containerId)).toEqual([containerA]);

    const containerB = savedContainer((await save(second, { productName: "Test spirulina", labelQuantity: "250", labelUnit: "g", amount: "label" })).redirect);
    expect(containerB).not.toBe(containerA);

    for (const c of [containerA, containerB]) {
      expect(await n(`select count(*) as n from inventory_movements where container_id = $1 and kind = 'opening'`, [c])).toBe(1);
    }
    const links = await db.query(
      `select capture_id, container_id from inventory_document_links
        where document_id = $1 and (capture_id is not null or container_id is not null)`,
      [upA.body.documentId],
    );
    expect(links.rows.filter((r) => r.capture_id).map((r) => r.capture_id).sort()).toEqual([first, second].sort());
    expect(links.rows.filter((r) => r.container_id).map((r) => r.container_id).sort()).toEqual([containerA, containerB].sort());
    // Each capture made its own container, and only that one.
    const made = await db.query(`select id, container_id from inventory_captures where id in ($1, $2)`, [first, second]);
    expect(Object.fromEntries(made.rows.map((r) => [r.id, r.container_id]))).toEqual({ [first]: containerA, [second]: containerB });
  });
});

describe("a weighing", () => {
  async function weighed(tareBasis: string) {
    const capture = await newCapture();
    const id = savedContainer(
      (await save(capture, { productName: `Test beet powder ${tareBasis}`, status: "open", amount: "weighed", grossG: "330", tareG: "30", tareBasis })).redirect,
    );
    const { rows } = await db.query(
      `select m.basis, m.quantity::text, m.unit, w.confidence, w.tare_basis, w.net_g::text, w.method, b.balance::text, b.balance_basis
         from inventory_movements m
         join inventory_measurements w on w.id = m.measurement_id
         join inventory_container_balances b on b.container_id = m.container_id
        where m.container_id = $1`,
      [id],
    );
    return rows[0];
  }

  test("with an estimated empty weight is an estimate, never measured", async () => {
    expect(await weighed("estimated")).toMatchObject({
      basis: "estimated",
      quantity: "300.0000",
      unit: "g",
      confidence: "estimated",
      tare_basis: "estimated",
      net_g: "300.000",
      balance_basis: "estimated",
    });
  });

  test("with a weighed empty container is measured, at the net", async () => {
    expect(await weighed("measured")).toMatchObject({
      basis: "measured",
      quantity: "300.0000",
      confidence: "exact",
      tare_basis: "measured",
      method: "scale",
      balance: "300.0000",
      balance_basis: "measured",
    });
  });

  test("is never a measured amount for a container counted in millilitres", async () => {
    const capture = await newCapture();
    const refused = await save(capture, { productName: "Test oil", labelQuantity: "500", labelUnit: "ml", status: "open", amount: "weighed", grossG: "600", tareG: "80", tareBasis: "measured" });
    expect(refused.state?.field).toBe("amount");

    // And the database holds the same line if a caller tried anyway.
    const { confirmCapture, InventoryError } = await import("@/lib/db/inventory");
    const { reviewSchema, REVIEW_FIELDS } = await import("@/lib/inventory/review");
    const input = reviewSchema.parse({
      ...Object.fromEntries(REVIEW_FIELDS.map((f) => [f, ""])),
      captureId: capture,
      product: "new",
      productName: "Test oil",
      status: "open",
      amount: "weighed",
    });
    await expect(
      confirmCapture(owner(A), input, {
        dimension: "volume",
        nominal: { quantity: "500", unit: "ml" },
        measurement: { grossG: "600", tareG: "80", tareBasis: "measured", confidence: "exact" },
        opening: { basis: "measured", quantity: "net", unit: "g" },
      }),
    ).rejects.toBeInstanceOf(InventoryError);
    expect(await n(`select count(*) as n from inventory_captures where id = $1 and status = 'open'`, [capture])).toBe(1);
  });
});

describe("another business", () => {
  test("cannot see, read, add to or save another business's item", async () => {
    const capture = await newCapture(A);
    const up = await upload(capture, jpeg(`private-${RUN}`));
    expect(up.status).toBe(200);

    as(B);
    const { getCapture, documentForDownload, listInventory } = await import("@/lib/db/inventory");
    expect(await getCapture(owner(B), capture)).toBeNull();
    expect(await documentForDownload(owner(B), up.body.documentId as string)).toBeNull();
    expect(await listInventory(owner(B))).toEqual([]);

    const { GET } = await import("@/app/api/inventory/documents/[id]/route");
    const image = await GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ id: up.body.documentId as string }) });
    expect(image.status).toBe(404);

    expect((await upload(capture, jpeg(`intruder-${RUN}`))).status).toBe(404);
    await expect(save(capture, { productName: "Not yours" })).rejects.toBeInstanceOf(h.NotFound);

    as(A);
    const own = await GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ id: up.body.documentId as string }) });
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(own.headers.get("content-type")).toBe("image/jpeg");
  });
});

describe("a business Inventory is not switched on for", () => {
  test("gets a 404 from every route and action", async () => {
    const capture = await newCapture(A);
    const up = await upload(capture, jpeg(`gate-${RUN}`));
    vi.stubEnv("INVENTORY_BUSINESSES", B.organizationId);

    expect((await upload(capture, jpeg(`gate-2-${RUN}`))).status).toBe(404);
    const { GET } = await import("@/app/api/inventory/documents/[id]/route");
    expect((await GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ id: up.body.documentId as string }) })).status).toBe(404);
    const { POST } = await import("@/app/api/inventory/captures/[id]/extract/route");
    expect((await POST(new Request("https://app.example.com/x", { method: "POST" }), { params: Promise.resolve({ id: capture }) })).status).toBe(404);
    await expect(save(capture, { productName: "Gated" })).rejects.toBeInstanceOf(h.NotFound);
    const { startCaptureAction } = await import("@/app/inventory/actions");
    await expect(startCaptureAction(new FormData())).rejects.toBeInstanceOf(h.NotFound);

    vi.stubEnv("INVENTORY_BUSINESSES", "");
    expect((await upload(capture, jpeg(`gate-3-${RUN}`))).status).toBe(404);
  });
});

describe("the label reader", () => {
  const ANSWER = {
    product_name: { value: "Test raw cacao powder", printed: "RAW CACAO POWDER", confidence: 0.93, photo: 1 },
    brand: { value: `Test brand ${RUN}`, printed: null, confidence: 0.9, photo: 1 },
    manufacturer: { value: null, printed: null, confidence: 0.1, photo: null },
    net_quantity: { amount: 454, unit: "g", printed: "NET WT 1 LB (454 g)", confidence: 0.88, photo: 1 },
    lot_code: { value: "L99", printed: "LOT L99", confidence: 0.6, photo: 2 },
    expiry: { date: "2027-05-31", kind: "best_before", printed: "BB 31/05/2027", confidence: 0.7, photo: 2 },
    gtin: { value: null, printed: null, confidence: 0.1, photo: null },
    form: { value: "powder", printed: null, confidence: 0.8, photo: 1 },
  };

  const allowed = {
    INVENTORY_VISION_MODEL: "test-vision:1b",
    OLLAMA_API_KEY: "test-ollama-key",
    OLLAMA_CLOUD_CLIENT_DATA: "true",
    OLLAMA_BASE_URL: "",
    OLLAMA_SELF_HOSTED: "",
  };

  function reader(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  }

  type Call = { path: string; auth: string | null; body: Record<string, unknown> };

  /**
   * A stand-in Ollama server: /api/show says what the model takes (or is not
   * there), /api/chat answers — the colour question with `probe`, a reading
   * with `content`.
   */
  function ollama(opts: { capabilities?: string[] | "unreachable" | "missing"; content?: string; probe?: string }) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      if (path === "/api/show") {
        if (opts.capabilities === "unreachable") throw new TypeError("fetch failed");
        if (opts.capabilities === "missing") return new Response("404 page not found", { status: 404 });
        return new Response(JSON.stringify({ capabilities: opts.capabilities ?? ["completion", "vision"] }));
      }
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      const isProbe = body.messages.some((m) => m.content.startsWith("What colour fills this image?"));
      const content = isProbe ? (opts.probe ?? "Red.") : (opts.content ?? JSON.stringify(ANSWER));
      return new Response(JSON.stringify({ message: { role: "assistant", content }, done: true }));
    });
    return calls;
  }

  const result = (read: number, overLimit = 0, unreadable = 0) => ({ read, notRead: { overLimit, unreadable }, limit: 6 });

  beforeEach(async () => {
    const { forgetVisionCapabilities } = await import("@/lib/inventory/extract");
    forgetVisionCapabilities();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  async function readLabels(capture: string) {
    const { POST } = await import("@/app/api/inventory/captures/[id]/extract/route");
    const res = await POST(new Request("https://app.example.com/x", { method: "POST" }), { params: Promise.resolve({ id: capture }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("sends nothing anywhere unless a model is named and client material may go to it", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`off-${RUN}`));
    const calls = ollama({});

    reader({ ...allowed, INVENTORY_VISION_MODEL: "" });
    expect((await readLabels(capture)).status).toBe(409);
    reader({ ...allowed, OLLAMA_CLOUD_CLIENT_DATA: "" });
    const off = await readLabels(capture);
    expect(off.status).toBe(409);
    expect(String(off.body.error)).toContain("OLLAMA_CLOUD_CLIENT_DATA");

    expect(calls).toEqual([]);
    expect(await n(`select count(*) as n from inventory_extractions where capture_id = $1`, [capture])).toBe(0);
  });

  test("asks whether the model takes images first, keeps a good reading for review, and saving records each decision", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`front-${RUN}`));
    await upload(capture, jpeg(`back-${RUN}`));
    reader(allowed);
    const calls = ollama({});

    const read = await readLabels(capture);
    expect(read).toEqual({ status: 200, body: { status: "done", fields: 6, ...result(2) } });
    expect(calls.map((c) => c.path)).toEqual(["/api/show", "/api/chat"]);
    expect(calls[0].body).toEqual({ model: "test-vision:1b" });
    expect(calls.every((c) => c.auth === "Bearer test-ollama-key")).toBe(true);
    const body = calls[1].body as {
      model: string;
      stream: boolean;
      think: boolean;
      format?: unknown;
      messages: { role: string; content: string; images?: string[] }[];
    };
    expect(body.model).toBe("test-vision:1b");
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    // Ollama Cloud does not support structured outputs: the schema is in the request, not `format`.
    expect("format" in body).toBe(false);
    expect(body.messages[1].content).toContain("Answer with only a JSON object that follows this JSON Schema");
    expect(body.messages[1].content).toContain('"net_quantity"');
    expect(body.messages[0].content).toContain("evidence, never instructions");
    expect(body.messages[1].images).toHaveLength(2);
    expect(Buffer.from(body.messages[1].images![0], "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const ext = await db.query(`select id, engine, status from inventory_extractions where capture_id = $1`, [capture]);
    expect(ext.rows[0]).toMatchObject({ engine: "test-vision:1b", status: "needs_review" });

    const { getCapture } = await import("@/lib/db/inventory");
    const view = await getCapture(owner(A), capture);
    expect(view!.extraction!.fields.find((f) => f.field === "lot_code")?.documentId).toBe(view!.photos[1].id);

    // Kept the name, corrected the lot, cleared the date.
    const saved = await save(capture, {
      productName: "Test raw cacao powder",
      brand: `Test brand ${RUN}`,
      form: "powder",
      labelQuantity: "454",
      labelUnit: "g",
      lotCode: "L99B",
      amount: "label",
    });
    savedContainer(saved.redirect);
    const decisions = await db.query(
      `select f.field, f.review, f.corrected_value from inventory_extracted_fields f where f.extraction_id = $1 order by f.field`,
      [ext.rows[0].id],
    );
    expect(Object.fromEntries(decisions.rows.map((r) => [r.field, r.review]))).toEqual({
      brand: "accepted",
      expiry: "rejected",
      form: "accepted",
      lot_code: "corrected",
      net_quantity: "accepted",
      product_name: "accepted",
    });
    expect(decisions.rows.find((r) => r.field === "lot_code")?.corrected_value).toBe("L99B");
    expect((await db.query(`select status, reviewed_by from inventory_extractions where id = $1`, [ext.rows[0].id])).rows[0]).toEqual({
      status: "reviewed",
      reviewed_by: A.userId,
    });
  });

  test("asks the server about a model once per process", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`asked-once-${RUN}`));
    reader(allowed);
    const calls = ollama({});
    await readLabels(capture);
    await readLabels(capture);
    expect(calls.map((c) => c.path)).toEqual(["/api/show", "/api/chat", "/api/chat"]);
  });

  test("sends a model that does not take images nothing, and records a failed reading that names it", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`text-only-${RUN}`));
    reader({ ...allowed, INVENTORY_VISION_MODEL: "test-text-only:1b" });
    const calls = ollama({ capabilities: ["completion", "tools"] });

    const read = await readLabels(capture);
    expect(read).toEqual({ status: 200, body: { status: "failed", error: "test-text-only:1b does not accept images.", ...result(0) } });
    expect(calls.map((c) => c.path)).toEqual(["/api/show"]);
    expect((await db.query(`select engine, status, error from inventory_extractions where capture_id = $1`, [capture])).rows[0]).toEqual({
      engine: "test-text-only:1b",
      status: "failed",
      error: "test-text-only:1b does not accept images.",
    });

    savedContainer((await save(capture, { productName: "Test typed after a text-only model", amount: "unknown" })).redirect);
  });

  test("where the server will not say what the model takes, asks it the colour of a red square — and sends photos only if it sees red", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`probe-${RUN}`));
    reader(allowed);
    let calls = ollama({ capabilities: "missing", probe: "It is blue." });
    const blind = await readLabels(capture);
    expect(blind.body).toMatchObject({ status: "failed", error: "test-vision:1b could not see a test image, so no photos are sent to it." });
    expect(calls.map((c) => c.path)).toEqual(["/api/show", "/api/chat"]);
    // The question carries one synthetic image: a red PNG, nothing from the item.
    const probe = calls[1].body as { messages: { images: string[] }[] };
    expect(probe.messages[0].images).toHaveLength(1);
    expect(Buffer.from(probe.messages[0].images[0], "base64").subarray(1, 4).toString()).toBe("PNG");

    const { forgetVisionCapabilities } = await import("@/lib/inventory/extract");
    forgetVisionCapabilities();
    calls = ollama({ capabilities: "unreachable", probe: "Red." });
    const seen = await readLabels(capture);
    expect(seen.body).toMatchObject({ status: "done" });
    expect(calls.map((c) => c.path)).toEqual(["/api/show", "/api/chat", "/api/chat"]);
  });

  test("reads an answer wrapped in one ```json fence, and nothing dug out of prose", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`fenced-${RUN}`));
    reader(allowed);
    ollama({ content: "```json\n" + JSON.stringify(ANSWER, null, 2) + "\n```" });
    expect((await readLabels(capture)).body).toMatchObject({ status: "done", fields: 6 });

    ollama({ content: "Here you go:\n```json\n" + JSON.stringify(ANSWER) + "\n```" });
    expect((await readLabels(capture)).body).toMatchObject({ status: "failed" });
  });

  test("takes a quantity written as a plain number in a string, and nothing looser", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`string-number-${RUN}`));
    reader(allowed);
    ollama({ content: JSON.stringify({ ...ANSWER, net_quantity: { ...ANSWER.net_quantity, amount: "250", confidence: "0.9", photo: "1" } }) });
    expect((await readLabels(capture)).body).toMatchObject({ status: "done", fields: 6 });
    const { getCapture } = await import("@/lib/db/inventory");
    const view = await getCapture(owner(A), capture);
    expect(view!.extraction!.fields.find((f) => f.field === "net_quantity")?.value).toEqual({ amount: 250, unit: "g" });

    ollama({ content: JSON.stringify({ ...ANSWER, net_quantity: { ...ANSWER.net_quantity, amount: "250 g" } }) });
    expect((await readLabels(capture)).body).toMatchObject({ status: "done", fields: 5 });
  });

  test("on a server of our own, also gives the schema as `format`", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`self-hosted-${RUN}`));
    reader({ ...allowed, OLLAMA_SELF_HOSTED: "true", OLLAMA_BASE_URL: "http://ollama.internal.test:11434", OLLAMA_CLOUD_CLIENT_DATA: "" });
    const calls = ollama({});
    expect((await readLabels(capture)).body).toMatchObject({ status: "done" });
    expect((calls[1].body as { format?: { type?: string } }).format?.type).toBe("object");
  });

  test("reads at most six photos and says how many it left out", async () => {
    const capture = await newCapture();
    for (let i = 0; i < 8; i++) await upload(capture, jpeg(`many-${i}-${RUN}`));
    reader(allowed);
    const calls = ollama({});
    expect((await readLabels(capture)).body).toEqual({ status: "done", fields: 6, ...result(6, 2) });
    expect((calls[1].body as { messages: { images?: string[] }[] }).messages[1].images).toHaveLength(6);
  });

  test("records a reading it cannot use as failed, and saving by hand still works", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`garbled-${RUN}`));
    reader(allowed);
    ollama({ content: "Sure! Here is the label: RAW CACAO" });
    const read = await readLabels(capture);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe("failed");
    expect((await db.query(`select status from inventory_extractions where capture_id = $1`, [capture])).rows[0].status).toBe("failed");

    savedContainer((await save(capture, { productName: "Test typed by hand", amount: "unknown" })).redirect);
  });

  test("logs only the model, counts and timings — never a photo or a word of a label", async () => {
    const capture = await newCapture();
    await upload(capture, jpeg(`quiet-${RUN}`));
    reader(allowed);
    ollama({});
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    for (const level of ["info", "log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(record);
    await readLabels(capture);
    const said = lines.join("\n");
    expect(said).toContain("model=test-vision:1b");
    expect(said).not.toMatch(/cacao|L99|RAW|synthetic label/i);
  });

  test("never sends a HEIC, and says so", async () => {
    const capture = await newCapture();
    const up = await upload(capture, heic(`heic-${RUN}`));
    expect(up.status).toBe(200);
    expect(up.body.contentType).toBe("image/heic");
    reader(allowed);
    const calls = ollama({});
    const read = await readLabels(capture);
    expect(read.status).toBe(400);
    expect(String(read.body.error)).toContain("HEIC");
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The quick screen: Sealed / Opened, the amount, Save and add another */
/* ------------------------------------------------------------------ */

describe("the quick screen", () => {
  const opening = async (container: string) =>
    (await db.query(`select kind, quantity::text, unit, basis from inventory_movements where container_id = $1`, [container])).rows;

  test("sealed with a valid label amount is saved at it; without one it is unknown — never 0", async () => {
    const withLabel = await newCapture();
    const a = savedContainer((await save(withLabel, { productName: "Test quick sealed", labelQuantity: "250", labelUnit: "g", status: "sealed", amount: "auto" })).redirect);
    expect(await opening(a)).toEqual([{ kind: "opening", quantity: "250.0000", unit: "g", basis: "labelled_unopened" }]);

    const bare = await newCapture();
    const b = savedContainer((await save(bare, { productName: "Test quick sealed, no label", status: "sealed", amount: "auto" })).redirect);
    expect(await opening(b)).toEqual([{ kind: "opening", quantity: null, unit: null, basis: "unknown" }]);
  });

  test("a label amount that is not a number is refused on its field, never dropped", async () => {
    const capture = await newCapture();
    const refused = await save(capture, { productName: "Test quick bad label", labelQuantity: "about 250", labelUnit: "g", status: "sealed", amount: "auto" });
    expect(refused.state).toMatchObject({ field: "labelQuantity" });
    expect(refused.state?.values?.labelQuantity).toBe("about 250");
    expect((await db.query(`select status from inventory_captures where id = $1`, [capture])).rows[0].status).toBe("open");
  });

  test("opened needs a choice: weighed, about, or not known — never the sealed label default", async () => {
    const capture = await newCapture();
    expect((await save(capture, { productName: "Test quick opened", status: "open", amount: "" })).state).toMatchObject({ field: "amount" });
    expect(
      (await save(capture, { productName: "Test quick opened", labelQuantity: "250", labelUnit: "g", status: "open", amount: "auto" })).state,
    ).toMatchObject({ field: "amount" });
    const container = savedContainer((await save(capture, { productName: "Test quick opened", status: "open", amount: "unknown" })).redirect);
    expect(await opening(container)).toEqual([{ kind: "opening", quantity: null, unit: null, basis: "unknown" }]);
  });

  test("Save and add another: one container and one next item, however often it is pressed — together or again later", async () => {
    const capture = await newCapture();
    const values = { productName: "Test quick next", status: "sealed", amount: "auto", then: "next" };
    const first = await save(capture, values);
    const m = new RegExp(`^/inventory/capture/([0-9a-f-]{36})\\?saved=([0-9a-f-]{36})$`).exec(first.redirect ?? "");
    expect(m, first.redirect ?? "").toBeTruthy();
    const [, next, container] = m!;
    expect(next).not.toBe(capture);

    const again = await Promise.all([save(capture, values), save(capture, values)]);
    for (const r of again) expect(r.redirect).toBe(`/inventory/capture/${next}?saved=${container}`);
    expect(await n(`select count(*) as n from inventory_containers c join inventory_captures k on k.container_id = c.id where k.id = $1`, [capture])).toBe(1);
    expect(await n(`select count(*) as n from inventory_captures where status = 'open' and created_by = $1 and created_at >= (select confirmed_at from inventory_captures where id = $2)`, [A.userId, capture])).toBe(1);
    // The next item starts empty: nothing of the saved item comes with it.
    expect(await n(`select count(*) as n from inventory_document_links where capture_id = $1`, [next])).toBe(0);
  });

  test("the next item is never someone else's, nor one already holding a photo", async () => {
    const capture = await newCapture();
    // Another person's empty item in this business, started after the save would be.
    const values = { productName: "Test quick next, others", status: "sealed", amount: "auto", then: "next" };
    const first = await save(capture, values);
    const next = /^\/inventory\/capture\/([0-9a-f-]{36})/.exec(first.redirect ?? "")![1];
    const others = (await db.query(`insert into inventory_captures (organization_id, created_by) values ($1, $2) returning id`, [A.organizationId, B.userId])).rows[0].id;
    await upload(next, jpeg(`quick-next-${RUN}`));
    const later = await save(capture, values);
    const again = /^\/inventory\/capture\/([0-9a-f-]{36})/.exec(later.redirect ?? "")![1];
    expect([next, others]).not.toContain(again);
    expect(later.redirect).toMatch(/\?saved=/);
  });
});

describe("what the reader read but cannot be used as it is", () => {
  test("is listed with what it read, beside its field — and a day that does not exist is not passed to a date field", async () => {
    const { unusableReadings, suggestionsFrom } = await import("@/lib/inventory/review");
    const fields = [
      { field: "net_quantity", value: { amount: "about 250", unit: "g" }, rawText: "NET WT ABOUT 250 G" },
      { field: "gtin", value: "12-34", rawText: null },
      { field: "expiry", value: { date: "2026-02-30", kind: "best_before" }, rawText: "BB 30 FEB 2026" },
      { field: "form", value: "goo", rawText: null },
      { field: "product_name", value: "Test cacao", rawText: null },
    ];
    expect(unusableReadings(fields)).toEqual([
      { field: "labelQuantity", read: "NET WT ABOUT 250 G" },
      { field: "gtin", read: "12-34" },
      { field: "expiryDate", read: "2026-02-30" },
      { field: "form", read: "goo" },
    ]);
    const suggested = suggestionsFrom(fields);
    expect(suggested.expiry).toEqual({ date: null, kind: "best_before", printed: "BB 30 FEB 2026" });
    expect(suggested.netQuantity).toBeUndefined();
    expect(suggested.productName).toBe("Test cacao");
  });
});
