import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * How a container was bought, and where its product is bought next — against
 * the real database as the application role (login 0049), through the same
 * server actions and routes the container page uses. Synthetic data only; the
 * media store and the session stand in.
 *
 *   per container        two jars of one lot: two sellers, two prices; the
 *                        lot, the product and the maker are untouched
 *   unknown              any field may stay empty and is saved as unknown; a
 *                        correction may clear a fact; history is kept
 *   price                this package's, with its currency; zero only typed
 *   a page that is old   refused unless it says what is already recorded;
 *                        the same request is answered once
 *   paperwork            a PDF or a photo, judged by its bytes, kept
 *                        privately, linked to the container as purchase
 *                        paperwork, never to a capture (so never read as a
 *                        label), never in the photo strip; one invoice for
 *                        several jars is one document
 *   stock                recording, retrying or reusing never changes it
 *   preferred seller     its own version; a purchase never changes it; the
 *                        alternatives stay
 *   last purchase        from current records, by date; undated is only
 *                        "most recently recorded", never by correction time
 *   another business     sees, attaches, cites and changes none of it
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
    store: new Map<string, { body: Uint8Array; type: string }>(),
    who: { businessId: "", userId: "", email: "" },
  };
});

vi.mock("@/lib/integrations/media-bucket", () => {
  class BucketError extends Error {}
  return {
    BucketError,
    mediaBucketConfigured: () => true,
    putObject: async (key: string, body: Uint8Array, type: string) => {
      h.store.set(key, { body, type });
    },
    getObject: async (key: string) => {
      const hit = h.store.get(key);
      if (!hit) throw new BucketError("The media store refused a download (404 NoSuchKey).");
      return hit.body;
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
  return { authorizeRequest: async () => granted(), requireAction: async () => granted(), requirePage: async () => granted() };
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
/** Companies made here are listed under this prefix and removed afterwards. */
const CO = `Test maker ${RUN}`;

const INVENTORY_TABLES = [
  "inventory_container_acquisitions",
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
  // TRUNCATE is not a row change: the records' keep-as-written trigger does not apply to removing test data.
  await db.query(`truncate table ${INVENTORY_TABLES.join(", ")} cascade`);
  await db.query(`delete from audit_events where action like 'inventory.%'`);
  await db.query(`delete from identities where organization_id in (select id from organizations where type = 'listed' and name like $1)`, [`${CO}%`]);
  await db.query(`delete from organizations where type = 'listed' and name like $1`, [`${CO}%`]);
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
const n = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0].n);
const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
const START = { error: null, field: null, values: null, at: 0 };

/** A synthetic container, catalogued the way the capture screen saves one. */
async function catalogue(values: Record<string, string> = {}, who = A) {
  const { createCapture } = await import("@/lib/db/inventory");
  const { saveCaptureAction } = await import("@/app/inventory/actions");
  as(who);
  const capture = await createCapture(owner(who));
  const form = new FormData();
  form.append("captureId", capture);
  for (const [k, v] of Object.entries({ product: "new", productName: `Bought item ${RUN}`, status: "sealed", amount: "unknown", ...values })) {
    form.append(k, v);
  }
  try {
    await saveCaptureAction(START, form);
  } catch (err) {
    const m = err instanceof h.Redirect ? /^\/inventory\?saved=([0-9a-f-]{36})$/.exec(err.url) : null;
    if (m) return m[1];
    throw err;
  }
  throw new Error("The capture was not saved.");
}

type Sent = { ok: boolean; redirect: string | null; error: string | null; field: string | null };

async function sent(action: (prev: typeof START, form: FormData) => Promise<{ error: string | null; field: string | null }>, fields: Record<string, string>): Promise<Sent> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  try {
    const state = await action(START, form);
    return { ok: false, redirect: null, error: state.error, field: state.field };
  } catch (err) {
    if (err instanceof h.Redirect) return { ok: true, redirect: err.url, error: null, field: null };
    throw err;
  }
}

/** Press "Save purchase details" on a page that showed `version`. */
async function purchase(containerId: string, version: string, fields: Record<string, string>, requestKey = randomUUID()) {
  const { savePurchaseAction } = await import("@/app/inventory/purchase-actions");
  return sent(savePurchaseAction, {
    containerId,
    version,
    requestKey,
    vendor: "",
    acquiredOn: "",
    price: "",
    currency: "CAD",
    documentId: "",
    today: new Date().toISOString().slice(0, 10),
    ...fields,
  });
}

async function preferred(containerId: string, version: string, vendor: string) {
  const { savePreferredVendorAction } = await import("@/app/inventory/purchase-actions");
  return sent(savePreferredVendorAction, { containerId, version, vendor });
}

async function view(containerId: string, who = A) {
  const { getContainerPurchase } = await import("@/lib/db/purchases");
  return getContainerPurchase(owner(who), containerId);
}

/** Send a file to a container's paperwork route, as the page does. */
async function paperwork(containerId: string, bytes: Uint8Array, name: string, type: string, sha256?: string) {
  const { POST } = await import("@/app/api/inventory/containers/[id]/paperwork/route");
  const form = new FormData();
  form.append("file", new File([Buffer.from(bytes)], name, { type }));
  form.append("sha256", sha256 ?? createHash("sha256").update(bytes).digest("hex"));
  const res = await POST(new Request("https://app.example.com/x", { method: "POST", body: form }), { params: Promise.resolve({ id: containerId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The product a container is of, to catalogue a second jar of it. */
const productOf = async (containerId: string) =>
  (await rows(`select l.product_id from inventory_containers c join inventory_lots l on l.id = c.lot_id where c.id = $1`, [containerId]))[0].product_id as string;

const pdf = (seed: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n% synthetic invoice ${seed}\n%%EOF\n`));
const jpeg = (seed: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic receipt ${seed}`)]));

const stock = async (containerId: string) => ({
  movements: await n(`select count(*) as n from inventory_movements where container_id = $1`, [containerId]),
  balance: (await rows(`select balance::text, balance_basis from inventory_container_balances where container_id = $1`, [containerId]))[0],
});

/* ------------------------------------------------------------------ */

describe("a container's purchase", () => {
  test("two jars of one lot can have two sellers and two prices; the lot, the product and the maker are untouched", async () => {
    const values = { productName: `Same lot ${RUN}`, lotCode: "LOT-2", manufacturer: `${CO} maker`, labelQuantity: "250", labelUnit: "g", amount: "auto" };
    const jar1 = await catalogue(values);
    const jar2 = await catalogue({ ...values, product: await productOf(jar1) });
    const lots = await rows(`select distinct lot_id from inventory_containers where id = any($1)`, [[jar1, jar2]]);
    expect(lots).toHaveLength(1);
    const lotBefore = await rows(`select * from inventory_lots where id = $1`, [lots[0].lot_id]);
    const productBefore = await rows(`select p.* from inventory_products p join inventory_lots l on l.product_id = p.id where l.id = $1`, [lots[0].lot_id]);

    expect((await purchase(jar1, "-", { vendor: `${CO} Shop A`, acquiredOn: "2026-09-01", price: "18,5", currency: "CAD" })).ok).toBe(true);
    expect((await purchase(jar2, "-", { vendor: `${CO} Shop B`, acquiredOn: "2026-10-02", price: "21", currency: "USD" })).ok).toBe(true);

    const [a, b] = [(await view(jar1))!.current!, (await view(jar2))!.current!];
    expect([a.vendor?.name, a.price, a.currency, a.acquiredOn]).toEqual([`${CO} Shop A`, "18.50", "CAD", "2026-09-01"]);
    expect([b.vendor?.name, b.price, b.currency, b.acquiredOn]).toEqual([`${CO} Shop B`, "21.00", "USD", "2026-10-02"]);
    expect(a.vendor!.idCode).toMatch(/^10X-[0-9A-Z]{5}$/);
    expect(await rows(`select * from inventory_lots where id = $1`, [lots[0].lot_id])).toEqual(lotBefore);
    expect(await rows(`select p.* from inventory_products p join inventory_lots l on l.product_id = p.id where l.id = $1`, [lots[0].lot_id])).toEqual(productBefore);
    // The maker is a business of its own, and is not made a seller by anything here.
    const maker = await rows(`select b.is_vendor from inventory_businesses b join organizations o on o.id = b.company_id where o.name = $1`, [`${CO} maker`]);
    expect(maker).toEqual([{ is_vendor: false }]);
  });

  test("anything may stay unknown; a first save needs one fact; a correction can clear one; every version is kept", async () => {
    const jar = await catalogue();
    const empty = await purchase(jar, "-", {});
    expect(empty).toMatchObject({ ok: false, field: "vendor" });
    expect(empty.error).toMatch(/at least one thing you know/);
    expect(await n(`select count(*) as n from inventory_container_acquisitions where container_id = $1`, [jar])).toBe(0);

    expect((await purchase(jar, "-", { acquiredOn: "2026-08-15" })).ok).toBe(true);
    const v1 = (await view(jar))!;
    expect([v1.current!.vendor, v1.current!.price, v1.current!.currency]).toEqual([null, null, null]);

    expect((await purchase(jar, v1.version, { price: "7.00", currency: "CAD" })).ok).toBe(true);
    const v2 = (await view(jar))!;
    expect([v2.current!.acquiredOn, v2.current!.price]).toEqual([null, "7.00"]);

    expect((await purchase(jar, v2.version, {})).ok).toBe(true);
    const v3 = (await view(jar))!;
    expect([v3.current!.acquiredOn, v3.current!.price, v3.current!.vendor, v3.current!.document]).toEqual([null, null, null, null]);
    expect(v3.history.map((r) => [r.acquiredOn, r.price])).toEqual([
      [null, null],
      [null, "7.00"],
      ["2026-08-15", null],
    ]);
    expect(v3.history[0].supersedes).toBe(v3.history[1].id);
    expect(v3.history[1].supersedes).toBe(v3.history[2].id);
  });

  test("a price is this package's, a number with its currency; zero only when typed; nothing is saved from a refused form", async () => {
    const jar = await catalogue();
    for (const [price, currency, field] of [
      ["abc", "CAD", "price"],
      ["-1", "CAD", "price"],
      ["1.234", "CAD", "price"],
      ["NaN", "CAD", "price"],
      ["Infinity", "CAD", "price"],
      ["12", "", "currency"],
      ["12", "cad", "currency"],
    ] as const) {
      const r = await purchase(jar, "-", { price, currency });
      expect(r, `${price} ${currency}`).toMatchObject({ ok: false, field });
    }
    expect(await purchase(jar, "-", { acquiredOn: "2999-01-01" })).toMatchObject({ ok: false, field: "acquiredOn" });
    expect(await purchase(jar, "-", { acquiredOn: "2026-02-30" })).toMatchObject({ ok: false, field: "acquiredOn" });
    expect(await n(`select count(*) as n from inventory_container_acquisitions where container_id = $1`, [jar])).toBe(0);

    expect((await purchase(jar, "-", { price: "0", currency: "EUR" })).ok).toBe(true);
    const v = (await view(jar))!;
    expect([v.current!.price, v.current!.currency]).toEqual(["0.00", "EUR"]);
    // A currency without a price is not recorded.
    expect((await purchase(jar, v.version, { vendor: `${CO} Market`, price: "", currency: "USD" })).ok).toBe(true);
    expect([(await view(jar))!.current!.price, (await view(jar))!.current!.currency]).toEqual([null, null]);
  });

  test("a page that is out of date is refused unless it says what is already recorded; the same request is answered once", async () => {
    const jar = await catalogue();
    const key = randomUUID();
    expect((await purchase(jar, "-", { vendor: `${CO} First`, price: "5.00" }, key)).ok).toBe(true);
    // The same request again (a retry): answered, nothing new.
    expect((await purchase(jar, "-", { vendor: `${CO} First`, price: "5.00" }, key)).ok).toBe(true);
    // The same request key with other values: refused.
    expect(await purchase(jar, "-", { vendor: `${CO} First`, price: "6.00" }, key)).toMatchObject({ ok: false, error: expect.stringMatching(/already sent/) });
    // Another page that still showed nothing recorded: refused with other values, accepted with the same.
    expect(await purchase(jar, "-", { vendor: `${CO} Other`, price: "5.00" })).toMatchObject({ ok: false, error: expect.stringMatching(/changed after this page was opened/) });
    expect((await purchase(jar, "-", { vendor: `${CO.toUpperCase()} FIRST`, price: "5.00" })).ok).toBe(true);
    expect(await n(`select count(*) as n from inventory_container_acquisitions where container_id = $1`, [jar])).toBe(1);

    // Two pages showing the same version save different values at once: one wins, the other is refused.
    const v = (await view(jar))!.version;
    const both = await Promise.all([purchase(jar, v, { price: "8.00" }), purchase(jar, v, { price: "9.00" })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)[0].error).toMatch(/changed after this page was opened/);
    expect(await n(`select count(*) as n from inventory_container_acquisitions where container_id = $1`, [jar])).toBe(2);
  });
});

describe("paperwork", () => {
  test("a PDF is judged by its bytes, kept privately as an invoice, linked to the container only, and served as a PDF", async () => {
    const jar = await catalogue();
    const before = await stock(jar);
    const bytes = pdf(`one-${RUN}`);
    const first = await paperwork(jar, bytes, "Invoice 0042.pdf", "application/pdf");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ name: "Invoice 0042.pdf", contentType: "application/pdf", reused: false });
    const id = first.body.id as string;
    const [doc] = await rows(`select kind, content_type, storage_key, state, capture_id from inventory_documents where id = $1`, [id]);
    expect(doc).toMatchObject({ kind: "invoice", content_type: "application/pdf", state: "stored", capture_id: null });
    expect(doc.storage_key).toMatch(new RegExp(`^inventory/${A.organizationId}/[A-Za-z0-9_-]{32}\\.pdf$`));
    expect(h.store.get(doc.storage_key)).toEqual({ body: bytes, type: "application/pdf" });
    expect(await rows(`select container_id, capture_id, role from inventory_document_links where document_id = $1`, [id])).toEqual([
      { container_id: jar, capture_id: null, role: "purchase" },
    ]);

    // The same bytes again: the same document, linked once.
    const again = await paperwork(jar, bytes, "Invoice 0042 (1).pdf", "application/pdf");
    expect(again.body).toMatchObject({ id, reused: true });
    expect(await n(`select count(*) as n from inventory_document_links where document_id = $1`, [id])).toBe(1);

    // Served through the documents route, as a PDF under its name, privately.
    const { GET } = await import("@/app/api/inventory/documents/[id]/route");
    const res = await GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Invoice 0042.pdf"; filename*=UTF-8''Invoice%200042.pdf`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    // Never in the container's photo strip; the stock is as it was.
    const { getContainer } = await import("@/lib/db/inventory");
    expect((await getContainer(owner(A), jar))!.photos.map((p) => p.id)).not.toContain(id);
    expect(await stock(jar)).toEqual(before);
  });

  test("only a PDF or a photo, at most 9MB, arriving as it was sent", async () => {
    const jar = await catalogue();
    expect((await paperwork(jar, new Uint8Array(Buffer.from("<html><script>alert(1)</script></html>")), "invoice.pdf", "application/pdf")).status).toBe(415);
    expect((await paperwork(jar, new Uint8Array(Buffer.from("PK\x03\x04 zip")), "invoice.zip", "application/zip")).status).toBe(415);
    const big = new Uint8Array(9 * 1024 * 1024 + 1);
    big.set(Buffer.from("%PDF-"));
    expect((await paperwork(jar, big, "big.pdf", "application/pdf")).status).toBe(413);
    expect((await paperwork(jar, pdf(`hash-${RUN}`), "x.pdf", "application/pdf", "0".repeat(64))).status).toBe(422);
    const photo = await paperwork(jar, jpeg(`receipt-${RUN}`), "IMG_7.jpg", "image/jpeg");
    expect(photo).toMatchObject({ status: 200, body: { contentType: "image/jpeg" } });
    // A receipt photo is paperwork, not a label photo.
    const { getContainer } = await import("@/lib/db/inventory");
    expect((await getContainer(owner(A), jar))!.photos.map((p) => p.id)).not.toContain(photo.body.id);
    expect(await n(`select count(*) as n from inventory_documents where organization_id = $1 and content_type not in ('application/pdf', 'image/jpeg')`, [A.organizationId])).toBe(0);
  });

  test("one invoice for two jars is one document; reused on the second jar's page, cited by both; retries add no stock", async () => {
    const [jar1, jar2] = [await catalogue({ labelQuantity: "250", labelUnit: "g", amount: "auto" }), await catalogue({ labelQuantity: "250", labelUnit: "g", amount: "auto" })];
    const before = [await stock(jar1), await stock(jar2)];
    const up = await paperwork(jar1, pdf(`shared-${RUN}`), "Order 77.pdf", "application/pdf");
    const doc = up.body.id as string;
    expect((await purchase(jar1, "-", { documentId: doc, price: "30.00", currency: "CAD" })).ok).toBe(true);

    // The second jar's page offers it, and saving there attaches it.
    expect((await view(jar2))!.reusable.map((r) => r.id)).toContain(doc);
    const key = randomUUID();
    expect((await purchase(jar2, "-", { documentId: doc, price: "30.00", currency: "CAD" }, key)).ok).toBe(true);
    expect((await purchase(jar2, "-", { documentId: doc, price: "30.00", currency: "CAD" }, key)).ok).toBe(true);
    expect(await rows(`select container_id, role from inventory_document_links where document_id = $1 order by container_id`, [doc])).toEqual(
      [jar1, jar2].sort().map((c) => ({ container_id: c, role: "purchase" })),
    );
    expect((await view(jar2))!.current!.document?.id).toBe(doc);
    expect(await n(`select count(*) as n from inventory_documents where id = $1`, [doc])).toBe(1);
    expect(await n(`select count(*) as n from inventory_container_acquisitions where document_id = $1`, [doc])).toBe(2);
    expect([await stock(jar1), await stock(jar2)]).toEqual(before);
  });

  test("paperwork that is not this business's, or has not arrived, cannot be cited", async () => {
    const jar = await catalogue();
    expect(await purchase(jar, "-", { documentId: randomUUID() })).toMatchObject({ ok: false, field: "documentId" });
    const pending = (await rows(
      `insert into inventory_documents (organization_id, kind, content_type, storage_key, byte_size, sha256, uploaded_by, state)
       values ($1, 'invoice', 'application/pdf', $2, 10, $3, $4, 'pending') returning id`,
      [A.organizationId, `inventory/${A.organizationId}/${randomBytes(24).toString("base64url")}.pdf`, randomBytes(32), A.userId],
    ))[0].id;
    expect(await purchase(jar, "-", { documentId: pending })).toMatchObject({ ok: false, field: "documentId", error: expect.stringMatching(/not finished arriving/) });
    expect(await n(`select count(*) as n from inventory_container_acquisitions where container_id = $1`, [jar])).toBe(0);
  });
});

describe("the preferred seller", () => {
  test("has its own version: a purchase never changes it, a stale page cannot overwrite it, and the alternatives stay", async () => {
    const jar = await catalogue({ productName: `Preferred ${RUN}` });
    expect((await preferred(jar, "-", `${CO} Usual`)).ok).toBe(true);
    const v1 = (await view(jar))!.preferred;
    expect(v1.vendor?.name).toBe(`${CO} Usual`);

    // An alternative at rank 2, as a buyer would keep one.
    const product = (await view(jar))!.product.id;
    const alt = (await rows(
      `insert into inventory_businesses (organization_id, company_id, is_vendor)
       select $1, company_id, true from list_company($2) returning id`,
      [A.organizationId, `${CO} Backup`],
    ))[0].id;
    await db.query(`insert into inventory_sourcing_preferences (organization_id, product_id, rank, vendor_id) values ($1, $2, 2, $3)`, [A.organizationId, product, alt]);

    // Recording where this jar was bought changes nothing about next time.
    expect((await purchase(jar, "-", { vendor: `${CO} Somewhere else`, price: "3.00" })).ok).toBe(true);
    expect((await view(jar))!.preferred).toEqual({ ...v1, alternatives: [`${CO} Backup`] });

    expect((await preferred(jar, v1.version, `${CO} Better`)).ok).toBe(true);
    const v2 = (await view(jar))!.preferred;
    expect([v2.vendor?.name, v2.alternatives]).toEqual([`${CO} Better`, [`${CO} Backup`]]);
    // The page that still showed "Usual": refused for another choice, accepted when it says what is already set.
    expect(await preferred(jar, v1.version, `${CO} Third`)).toMatchObject({ ok: false, error: expect.stringMatching(/changed after this page was opened/) });
    expect((await preferred(jar, v1.version, `${CO} Better`)).ok).toBe(true);

    // Cleared: no preferred seller; the alternative stays; the old choices are kept, inactive.
    expect((await preferred(jar, v2.version, "")).ok).toBe(true);
    const v3 = (await view(jar))!.preferred;
    expect([v3.vendor, v3.alternatives]).toEqual([null, [`${CO} Backup`]]);
    expect(await rows(`select rank, active from inventory_sourcing_preferences where product_id = $1 order by created_at`, [product])).toEqual([
      { rank: 1, active: false },
      { rank: 2, active: true },
      { rank: 1, active: false },
    ]);
    expect(await n(`select count(*) as n from audit_events where action = 'inventory.product.preferred_vendor_changed' and target = $1`, [`inventory_products:${product}`])).toBe(3);
  });
});

describe("the product's last purchase", () => {
  test("comes from each jar's current record, by purchase date; without dates it is only the most recently recorded", async () => {
    const name = `Last bought ${RUN}`;
    const jar1 = await catalogue({ productName: name });
    const product = await productOf(jar1);
    const [jar2, jar3] = [await catalogue({ product }), await catalogue({ product })];
    expect((await view(jar1))!.product.id).toBe((await view(jar3))!.product.id);

    // Undated only: the order they were first recorded in.
    expect((await purchase(jar1, "-", { vendor: `${CO} Early`, price: "1.00" })).ok).toBe(true);
    expect((await purchase(jar2, "-", { vendor: `${CO} Late`, price: "2.00" })).ok).toBe(true);
    expect((await view(jar3))!.lastBought).toMatchObject({ vendorName: `${CO} Late`, dated: "none", containerId: jar2 });
    // Correcting the earlier jar does not make it the latest purchase.
    expect((await purchase(jar1, (await view(jar1))!.version, { vendor: `${CO} Early`, price: "1.50" })).ok).toBe(true);
    expect((await view(jar3))!.lastBought).toMatchObject({ vendorName: `${CO} Late`, dated: "none" });

    // With a date, the date decides; undated ones make it only the latest dated purchase.
    expect((await purchase(jar1, (await view(jar1))!.version, { vendor: `${CO} Early`, price: "1.50", acquiredOn: "2026-06-01" })).ok).toBe(true);
    expect((await view(jar3))!.lastBought).toMatchObject({ vendorName: `${CO} Early`, acquiredOn: "2026-06-01", dated: "some" });
    expect((await purchase(jar2, (await view(jar2))!.version, { vendor: `${CO} Late`, price: "2.00", acquiredOn: "2026-05-01" })).ok).toBe(true);
    expect((await view(jar3))!.lastBought).toMatchObject({ vendorName: `${CO} Early`, dated: "all" });
  });
});

describe("another business", () => {
  test("sees none of it, cannot attach to it, cite it or save over it", async () => {
    const jar = await catalogue();
    const up = await paperwork(jar, pdf(`private-${RUN}`), "Private.pdf", "application/pdf");
    expect((await purchase(jar, "-", { vendor: `${CO} Private shop`, documentId: up.body.id as string, price: "4.00" })).ok).toBe(true);
    const theirs = await catalogue({ productName: `Other business item ${RUN}` }, B);

    as(B);
    expect(await view(jar, B)).toBeNull();
    await expect(purchase(jar, "-", { price: "1.00" })).rejects.toBeInstanceOf(h.NotFound);
    expect((await paperwork(jar, pdf(`smuggled-${RUN}`), "x.pdf", "application/pdf")).status).toBe(404);
    expect(await purchase(theirs, "-", { documentId: up.body.id as string })).toMatchObject({ ok: false, field: "documentId" });
    const { GET } = await import("@/app/api/inventory/documents/[id]/route");
    expect((await GET(new Request("https://app.example.com/x"), { params: Promise.resolve({ id: up.body.id as string }) })).status).toBe(404);
    expect((await view(theirs, B))!.reusable).toEqual([]);
    expect(await n(`select count(*) as n from inventory_container_acquisitions where organization_id = $1`, [B.organizationId])).toBe(0);
  });
});
