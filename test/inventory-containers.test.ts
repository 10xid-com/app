import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "pg";

/**
 * One catalogued container, after it was saved: its page, what is in it now,
 * opening it, where it is — against the real database as the application role
 * (login's 0048), through the same server actions the page's forms post to.
 * Synthetic containers only; the session stands in.
 *
 *   a later amount        a NEW count, appended: about how much, or weighed
 *                         ("measured" only with the empty container weighed);
 *                         the opening and every earlier event stay as they were
 *   unknown               stays unknown: never zero, never made up
 *   opening               a package at its label amount needs a new amount;
 *                         an estimate or a weighing is kept
 *   a page that is old    refused: the version is the row's last change to the
 *                         microsecond and the ledger, reversals included, read
 *                         in the same statement as what the page shows
 *   the same request      answered once; with other values, another change or
 *                         another container, refused
 *   another business      sees and changes none of it
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
    who: { businessId: "", userId: "", email: "" },
    /** Run once, right after the first statement of the next owner transaction: a write by someone else in between. */
    afterFirstStatement: null as null | (() => Promise<void>),
  };
});

vi.mock("@/lib/integrations/media-bucket", () => {
  class BucketError extends Error {}
  return {
    BucketError,
    mediaBucketConfigured: () => true,
    putObject: async () => undefined,
    getObject: async () => new Uint8Array(),
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

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  resolveIdentity: async () => ({ state: "active", csrfToken: "test-csrf" }),
}));

vi.mock("@/lib/db/connection", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db/connection")>();
  return {
    ...real,
    inOwnerTransaction: <T,>(organizationId: string, userId: string, fn: (tx: Parameters<Parameters<typeof real.inOwnerTransaction>[2]>[0]) => Promise<T>) =>
      real.inOwnerTransaction(organizationId, userId, (tx) => {
        const inject = h.afterFirstStatement;
        if (!inject) return fn(tx);
        h.afterFirstStatement = null;
        let first = true;
        const proxied = new Proxy(tx, {
          get(target, prop) {
            if (prop === "execute") {
              return async (...args: unknown[]) => {
                const result = await (target.execute as (...a: unknown[]) => Promise<unknown>).apply(target, args);
                if (first) {
                  first = false;
                  await inject();
                }
                return result;
              };
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        return fn(proxied);
      }),
  };
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
  await db.query(`delete from audit_events where action like 'inventory.container.%'`);
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
  h.afterFirstStatement = null;
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
/** The phone's date in these tests: the server's, so it is always within a day. */
const TODAY = new Date().toISOString().slice(0, 10);

/** A synthetic container, catalogued the way the capture screen saves one. */
async function catalogue(values: Record<string, string> = {}, who = A) {
  const { createCapture } = await import("@/lib/db/inventory");
  const { saveCaptureAction } = await import("@/app/inventory/actions");
  const capture = await createCapture(owner(who));
  const form = new FormData();
  form.append("captureId", capture);
  for (const [k, v] of Object.entries({ product: "new", productName: `Synthetic item ${RUN}`, status: "sealed", amount: "unknown", ...values })) {
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

const SEALED_250G = { labelQuantity: "250", labelUnit: "g", amount: "label" };

async function view(containerId: string, who = A) {
  const { getContainer } = await import("@/lib/db/inventory");
  return getContainer(owner(who), containerId);
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

/** Press "Save amount" (or "Mark opened") on a page that showed `version`. */
async function amount(containerId: string, version: string, fields: Record<string, string>) {
  const { recordAmountAction } = await import("@/app/inventory/actions");
  return sent(recordAmountAction, { containerId, version, requestKey: randomUUID(), intent: "amount", today: "", ...fields });
}

async function details(containerId: string, version: string, fields: { location?: string; notes?: string }) {
  const { saveContainerDetailsAction } = await import("@/app/inventory/actions");
  return sent(saveContainerDetailsAction, { containerId, version, location: "", notes: "", ...fields });
}

const ledger = (containerId: string) =>
  rows(
    `select m.kind, m.quantity::text, m.unit, m.basis, m.idempotency_key, ms.gross_g::text, ms.tare_g::text, ms.net_g::text, ms.confidence
       from inventory_movements m left join inventory_measurements ms on ms.id = m.measurement_id
      where m.container_id = $1 order by m.created_at, m.id`,
    [containerId],
  );

const balance = async (containerId: string) =>
  (await rows(`select balance::text, balance_basis from inventory_container_balances where container_id = $1`, [containerId]))[0] as {
    balance: string | null;
    balance_basis: string;
  };

/* ------------------------------------------------------------------ */

describe("the container's page", () => {
  test("shows what it is, who makes it, its lot, the label amount, what is in it now and its history", async () => {
    const id = await catalogue({
      ...SEALED_250G,
      brand: "Example Pantry",
      manufacturer: `Test maker ${RUN} page`,
      lotCode: "TEST-1042",
      expiryDate: "2028-03-31",
      expiryKind: "best_before",
      location: "Pantry shelf 1",
      notes: "Synthetic",
    });
    const c = (await view(id))!;
    expect(c.product).toMatchObject({ name: `Synthetic item ${RUN}`, brand: "Example Pantry", maker: { name: `Test maker ${RUN} page` } });
    expect(c.product.maker!.idCode).toMatch(/^10X-[0-9A-Z]{5}$/);
    expect(c.lot).toMatchObject({ code: "TEST-1042", expiryDate: "2028-03-31", expiryKind: "best_before" });
    expect(c.nominal).toEqual({ quantity: "250.0000", unit: "g" });
    expect(c).toMatchObject({ status: "sealed", balance: "250.0000", balanceBasis: "labelled_unopened", location: "Pantry shelf 1", notes: "Synthetic" });
    expect(c.version).toMatch(/^v1\.\d{16,}\.1\.[0-9a-f-]{36}$/);
    expect(c.movements.map((m) => [m.kind, m.basis, m.byYou])).toEqual([["opening", "labelled_unopened", true]]);
  });

  test("is a 404 for another business's container, and where inventory is switched off", async () => {
    const id = await catalogue();
    const { default: ContainerPage } = await import("@/app/inventory/containers/[id]/page");
    const open = () => ContainerPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });

    await expect(open()).resolves.toBeTruthy();
    as(B);
    expect(await view(id, B)).toBeNull();
    await expect(open()).rejects.toBeInstanceOf(h.NotFound);
    const c = (await view(id))!;
    await expect(amount(id, c.version, { amount: "estimate", estimateQuantity: "1", estimateUnit: "g" })).rejects.toBeInstanceOf(h.NotFound);
    await expect(details(id, c.version, { location: "Elsewhere" })).rejects.toBeInstanceOf(h.NotFound);
    expect(await ledger(id)).toHaveLength(1);

    as(A);
    vi.stubEnv("INVENTORY_BUSINESSES", B.organizationId);
    await expect(open()).rejects.toBeInstanceOf(h.NotFound);
    await expect(amount(id, c.version, { amount: "estimate", estimateQuantity: "1", estimateUnit: "g" })).rejects.toBeInstanceOf(h.NotFound);
  });
});

describe("what is in it now", () => {
  test("an estimate is a new count; the opening and everything before it stay exactly as they were", async () => {
    const id = await catalogue(SEALED_250G);
    const before = await ledger(id);
    const c = (await view(id))!;
    const res = await amount(id, c.version, { amount: "estimate", estimateQuantity: "180", estimateUnit: "g" });
    expect(res).toMatchObject({ ok: true, redirect: `/inventory/containers/${id}?done=amount` });
    const after = await ledger(id);
    expect(after[0]).toEqual(before[0]);
    expect(after.slice(1)).toEqual([
      expect.objectContaining({ kind: "count", quantity: "180.0000", unit: "g", basis: "estimated", gross_g: null }),
    ]);
    expect(await balance(id)).toEqual({ balance: "180.0000", balance_basis: "estimated" });
  });

  test("weighed with the empty container weighed is measured: one weighing, the count is its exact net", async () => {
    const id = await catalogue(SEALED_250G);
    const c = (await view(id))!;
    expect((await amount(id, c.version, { amount: "weighed", grossG: "412.5", tareG: "100.25", tareBasis: "measured" })).ok).toBe(true);
    const counts = (await ledger(id)).filter((m) => m.kind === "count");
    expect(counts).toEqual([
      expect.objectContaining({ quantity: "312.2500", unit: "g", basis: "measured", gross_g: "412.500", tare_g: "100.250", net_g: "312.250", confidence: "exact" }),
    ]);
    expect(await n(`select count(*) as n from inventory_measurements where container_id = $1`, [id])).toBe(1);
    expect(await balance(id)).toEqual({ balance: "312.2500", balance_basis: "measured" });
  });

  test("weighed with an estimated empty weight is an estimate; without an empty weight nothing is recorded", async () => {
    const id = await catalogue(SEALED_250G);
    let c = (await view(id))!;
    const bare = await amount(id, c.version, { amount: "weighed", grossG: "300" });
    expect(bare).toMatchObject({ ok: false, field: "tareG" });
    expect(await ledger(id)).toHaveLength(1);
    expect(await n(`select count(*) as n from inventory_measurements where container_id = $1`, [id])).toBe(0);

    c = (await view(id))!;
    expect((await amount(id, c.version, { amount: "weighed", grossG: "300", tareG: "90", tareBasis: "estimated" })).ok).toBe(true);
    expect((await ledger(id)).at(-1)).toMatchObject({ kind: "count", quantity: "210.0000", basis: "estimated", confidence: "estimated" });
    expect(await balance(id)).toEqual({ balance: "210.0000", balance_basis: "estimated" });
  });

  test("is in the container's own kind of unit, and weighed only in grams", async () => {
    const mass = await catalogue(SEALED_250G);
    const c = (await view(mass))!;
    expect(await amount(mass, c.version, { amount: "estimate", estimateQuantity: "100", estimateUnit: "ml" })).toMatchObject({ ok: false, field: "estimateUnit" });
    const liquid = await catalogue({ labelQuantity: "500", labelUnit: "ml", amount: "label" });
    const l = (await view(liquid))!;
    expect(await amount(liquid, l.version, { amount: "weighed", grossG: "600", tareG: "100", tareBasis: "measured" })).toMatchObject({ ok: false, field: "amount" });
    expect((await amount(liquid, l.version, { amount: "estimate", estimateQuantity: "0.3", estimateUnit: "l" })).ok).toBe(true);
    expect(await balance(liquid)).toEqual({ balance: "300.0000", balance_basis: "estimated" });
    expect(await ledger(mass)).toHaveLength(1);
  });

  test("zero is recorded only when it is said", async () => {
    const id = await catalogue(SEALED_250G);
    const c = (await view(id))!;
    expect((await amount(id, c.version, { amount: "estimate", estimateQuantity: "0", estimateUnit: "g" })).ok).toBe(true);
    expect(await balance(id)).toEqual({ balance: "0.0000", balance_basis: "estimated" });
  });

  test("unknown stays unknown: there is no later 'unknown', and opening or moving it makes nothing up", async () => {
    const id = await catalogue({ amount: "unknown" });
    let c = (await view(id))!;
    expect(await amount(id, c.version, { amount: "" })).toMatchObject({ ok: false, field: "amount" });
    expect((await amount(id, c.version, { intent: "open", amount: "", today: TODAY })).ok).toBe(true);
    c = (await view(id))!;
    expect((await details(id, c.version, { location: "Fridge" })).ok).toBe(true);
    expect(await balance(id)).toEqual({ balance: null, balance_basis: "unknown" });
    expect((await ledger(id)).map((m) => [m.kind, m.quantity, m.basis])).toEqual([["opening", null, "unknown"]]);
    expect((await view(id))!).toMatchObject({ status: "open", openedOn: TODAY, location: "Fridge", balance: null });
  });
});

describe("opening", () => {
  test("a package at its label amount needs a new amount with it, and is never shown 'as labelled, sealed' once open", async () => {
    const id = await catalogue(SEALED_250G);
    let c = (await view(id))!;
    const bare = await amount(id, c.version, { intent: "open", amount: "", today: TODAY });
    expect(bare).toMatchObject({ ok: false, field: "amount" });
    expect((await view(id))!.status).toBe("sealed");

    c = (await view(id))!;
    const opened = await amount(id, c.version, { intent: "open", amount: "estimate", estimateQuantity: "240", estimateUnit: "g", today: TODAY });
    expect(opened).toMatchObject({ ok: true, redirect: `/inventory/containers/${id}?done=opened` });
    c = (await view(id))!;
    expect(c).toMatchObject({ status: "open", openedOn: TODAY, balance: "240.0000", balanceBasis: "estimated" });
    expect((await ledger(id)).map((m) => m.kind)).toEqual(["opening", "count"]);
    expect(c.changes.map((e) => [e.action, e.byYou])).toEqual([["inventory.container.opened", true]]);
    expect(await n(`select count(*) as n from audit_events where target = $1 and actor_user_id = $2`, [`inventory_containers:${id}`, A.userId])).toBe(1);
  });

  test("keeps an estimate or a weighing as it is; opening what is open already is done", async () => {
    const id = await catalogue({ amount: "estimate", estimateQuantity: "90", estimateUnit: "g" });
    let c = (await view(id))!;
    expect((await amount(id, c.version, { intent: "open", amount: "", today: TODAY })).ok).toBe(true);
    expect(await balance(id)).toEqual({ balance: "90.0000", balance_basis: "estimated" });
    expect(await ledger(id)).toHaveLength(1);
    // A second press, from the same (now old) page: done, nothing more written.
    expect((await amount(id, c.version, { intent: "open", amount: "", today: TODAY })).ok).toBe(true);
    c = (await view(id))!;
    expect(c.changes).toHaveLength(1);
  });

  test("uses the phone's date only within a day of the server's", async () => {
    const { openedOn } = await import("@/lib/inventory/container");
    const now = new Date("2026-10-19T03:30:00Z");
    expect(openedOn("2026-10-18", now)).toBe("2026-10-18");
    expect(openedOn("2026-10-20", now)).toBe("2026-10-20");
    expect(openedOn("2026-01-01", now)).toBe("2026-10-19");
    expect(openedOn(undefined, now)).toBe("2026-10-19");
  });
});

describe("where it is", () => {
  test("a place is found by name with any capitals, or made; notes keep their lines; each change is on the record", async () => {
    const id = await catalogue();
    let c = (await view(id))!;
    expect((await details(id, c.version, { location: "Pantry Shelf 3" })).ok).toBe(true);
    c = (await view(id))!;
    expect((await details(id, c.version, { location: "pantry shelf 3", notes: "first line\r\nsecond line" })).ok).toBe(true);
    c = (await view(id))!;
    expect(c).toMatchObject({ location: "Pantry Shelf 3", notes: "first line\nsecond line" });
    expect(await n(`select count(*) as n from inventory_locations where lower(name) = 'pantry shelf 3'`)).toBe(1);
    expect(c.changes.map((e) => e.action).sort()).toEqual(["inventory.container.notes_changed", "inventory.container.place_changed"]);
    expect((await details(id, c.version, { location: "", notes: "" })).ok).toBe(true);
    expect((await view(id))!).toMatchObject({ location: null, notes: null });
  });
});

describe("a page that saw an older container", () => {
  test("is told so: the version is exact to the microsecond, never a JavaScript millisecond", async () => {
    const id = await catalogue(SEALED_250G);
    await db.query(`update inventory_containers set updated_at = '2026-10-19 12:00:00.123456+00' where id = $1`, [id]);
    const c = (await view(id))!;
    const stamp = String(Date.parse("2026-10-19T12:00:00.123Z")) + "456";
    expect(c.version.split(".")[1]).toBe(stamp);
    const millis = c.version.replace(`.${stamp}.`, `.${stamp.slice(0, -3)}000.`);
    expect(await amount(id, millis, { amount: "estimate", estimateQuantity: "1", estimateUnit: "g" })).toMatchObject({ ok: false });
    expect(await ledger(id)).toHaveLength(1);
    expect((await amount(id, c.version, { amount: "estimate", estimateQuantity: "1", estimateUnit: "g" })).ok).toBe(true);
  });

  test("every write moves the version forward, even when the stored time is ahead of the clock", async () => {
    const id = await catalogue(SEALED_250G);
    await db.query(`update inventory_containers set updated_at = now() + interval '1 hour' where id = $1`, [id]);
    const before = (await rows(`select (extract(epoch from updated_at) * 1000000)::bigint::text as us from inventory_containers where id = $1`, [id]))[0].us;
    const c = (await view(id))!;
    expect((await details(id, c.version, { notes: "moved on" })).ok).toBe(true);
    const after = (await rows(`select (extract(epoch from updated_at) * 1000000)::bigint::text as us from inventory_containers where id = $1`, [id]))[0].us;
    expect(BigInt(after) > BigInt(before)).toBe(true);
    expect((await view(id))!.version).not.toBe(c.version);
  });

  test("a reversal written since is a change too: the old page is refused", async () => {
    const id = await catalogue(SEALED_250G);
    let c = (await view(id))!;
    expect((await amount(id, c.version, { amount: "estimate", estimateQuantity: "200", estimateUnit: "g" })).ok).toBe(true);
    c = (await view(id))!;
    const stamp = (await rows(`select updated_at::text from inventory_containers where id = $1`, [id]))[0].updated_at;
    const count = (await rows(`select id from inventory_movements where container_id = $1 and kind = 'count'`, [id]))[0].id;
    await db.query(
      `insert into inventory_movements (organization_id, container_id, kind, reverses_id, note) values ($1, $2, 'reversal', $3, 'synthetic: miscounted')`,
      [A.organizationId, id, count],
    );
    expect((await rows(`select updated_at::text from inventory_containers where id = $1`, [id]))[0].updated_at).toBe(stamp);
    const stale = await amount(id, c.version, { amount: "estimate", estimateQuantity: "150", estimateUnit: "g" });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/changed after this page was opened/);
    expect(await ledger(id)).toHaveLength(3);
    expect(await balance(id)).toEqual({ balance: "250.0000", balance_basis: "labelled_unopened" });
  });

  test("two pages sending different amounts at once: one is saved, the other refused", async () => {
    const id = await catalogue(SEALED_250G);
    const c = (await view(id))!;
    const results = await Promise.all([
      amount(id, c.version, { amount: "estimate", estimateQuantity: "100", estimateUnit: "g" }),
      amount(id, c.version, { amount: "estimate", estimateQuantity: "120", estimateUnit: "g" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)[0].error).toMatch(/changed after this page was opened/);
    expect((await ledger(id)).filter((m) => m.kind === "count")).toHaveLength(1);
  });

  test("a change committed while the page was being read cannot pair the old notes with the new version", async () => {
    const id = await catalogue({ notes: "Original note" });
    // Someone else's edit lands between the page's statements.
    h.afterFirstStatement = async () => {
      await db.query(
        `update inventory_containers set notes = 'Newer edit', updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond') where id = $1`,
        [id],
      );
    };
    const page = (await view(id))!;
    expect(page.notes).toBe("Original note");
    expect((await rows(`select notes from inventory_containers where id = $1`, [id]))[0].notes).toBe("Newer edit");

    // The page sends what it showed, with a new place.
    const res = await details(id, page.version, { location: "Shelf 9", notes: page.notes ?? "" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/changed after this page was opened/);
    expect((await rows(`select notes, location_id from inventory_containers where id = $1`, [id]))[0]).toEqual({ notes: "Newer edit", location_id: null });
  });

  test("details sent again with what is already there are done, even from an old page; anything else from it is refused", async () => {
    const id = await catalogue();
    const c = (await view(id))!;
    expect((await details(id, c.version, { location: "Cupboard" })).ok).toBe(true);
    expect((await details(id, c.version, { location: "cupboard" })).ok).toBe(true);
    expect(await details(id, c.version, { location: "Cupboard", notes: "different" })).toMatchObject({ ok: false });
    expect((await view(id))!).toMatchObject({ location: "Cupboard", notes: null });
    expect(await n(`select count(*) as n from audit_events where target = $1`, [`inventory_containers:${id}`])).toBe(1);
  });
});

describe("the same request sent again", () => {
  async function press(containerId: string, version: string, requestKey: string, fields: Record<string, string>) {
    const { recordAmountAction } = await import("@/app/inventory/actions");
    return sent(recordAmountAction, { containerId, version, requestKey, intent: "amount", today: "", ...fields });
  }
  const WEIGHED = { amount: "weighed", grossG: "350", tareG: "100", tareBasis: "measured" };

  test("is answered once: one count, one weighing", async () => {
    const id = await catalogue(SEALED_250G);
    const c = (await view(id))!;
    const key = randomUUID();
    expect((await press(id, c.version, key, WEIGHED)).ok).toBe(true);
    expect((await press(id, c.version, key, WEIGHED)).ok).toBe(true);
    expect((await press(id, c.version, key, { ...WEIGHED, grossG: "350.000" })).ok).toBe(true);
    expect((await ledger(id)).filter((m) => m.kind === "count")).toHaveLength(1);
    expect(await n(`select count(*) as n from inventory_measurements where container_id = $1`, [id])).toBe(1);
  });

  test("two at once are answered once", async () => {
    const id = await catalogue(SEALED_250G);
    const c = (await view(id))!;
    const key = randomUUID();
    const results = await Promise.all([press(id, c.version, key, WEIGHED), press(id, c.version, key, WEIGHED)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await ledger(id)).filter((m) => m.kind === "count")).toHaveLength(1);
    expect(await n(`select count(*) as n from inventory_measurements where container_id = $1`, [id])).toBe(1);
  });

  test("with other values, as another change, or for another container, is refused — never taken for the old success", async () => {
    const id = await catalogue(SEALED_250G);
    const other = await catalogue(SEALED_250G);
    const c = (await view(id))!;
    const key = randomUUID();
    expect((await press(id, c.version, key, { amount: "estimate", estimateQuantity: "180", estimateUnit: "g" })).ok).toBe(true);

    const changed = await press(id, c.version, key, { amount: "estimate", estimateQuantity: "181", estimateUnit: "g" });
    expect(changed).toMatchObject({ ok: false, error: expect.stringMatching(/already sent/) });
    const otherUnit = await press(id, c.version, key, { amount: "estimate", estimateQuantity: "0.18", estimateUnit: "kg" });
    expect(otherUnit).toMatchObject({ ok: false, error: expect.stringMatching(/already sent/) });
    const asOpen = await press(id, c.version, key, { intent: "open", amount: "estimate", estimateQuantity: "180", estimateUnit: "g" });
    expect(asOpen).toMatchObject({ ok: false, error: expect.stringMatching(/already sent/) });
    const o = (await view(other))!;
    const elsewhere = await press(other, o.version, key, { amount: "estimate", estimateQuantity: "180", estimateUnit: "g" });
    expect(elsewhere).toMatchObject({ ok: false, error: expect.stringMatching(/already sent/) });

    expect((await ledger(id)).filter((m) => m.kind === "count")).toEqual([expect.objectContaining({ quantity: "180.0000", unit: "g" })]);
    expect(await ledger(other)).toHaveLength(1);
    expect((await view(id))!.status).toBe("sealed");
  });
});
