import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { DatabaseError } from "pg";
import { inOwnerTransaction, type Transaction } from "./connection";
import { ALREADY_SENT, CHANGED_SINCE, InventoryError, type InventoryOwner } from "./inventory";
import type { PreferredInput, PurchaseInput } from "@/lib/inventory/purchase";

/**
 * How one container was bought, and where its product is bought from next.
 *
 * Three things are kept apart (login 0049, docs/inventory.md "Purchases of a
 * container"):
 *
 *   this container's purchase   seller, date, price with its currency, and the
 *                               paperwork — each a fact or unknown, never a
 *                               guess. Saved as a new full record that
 *                               supersedes the current one; nothing earlier is
 *                               changed, so the history stays. The current
 *                               record's id is the version the form carries.
 *   the product's last purchase derived from the current records of all its
 *                               containers, by purchase date; without dates it
 *                               is only "most recently recorded"
 *   the preferred seller        the product's rank-1 sourcing preference, with
 *                               its own version; the alternatives are untouched
 *
 * Recording or correcting a purchase never writes to the ledger: what is in a
 * container stays exactly as it was. Paperwork is a private document of this
 * business, linked to the container as purchase paperwork; it is never linked
 * to a capture, so the label reader never sees it.
 */

type Row = Record<string, unknown>;

async function all<T extends Row>(tx: Transaction, query: SQL): Promise<T[]> {
  return (await tx.execute<T>(query)).rows as T[];
}

async function one<T extends Row>(tx: Transaction, query: SQL): Promise<T | undefined> {
  return (await all<T>(tx, query))[0];
}

const run = <T>(owner: InventoryOwner, fn: (tx: Transaction) => Promise<T>) =>
  inOwnerTransaction(owner.organizationId, owner.userId, fn);

function when(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** A refusal from 0049's rules or constraints, as a sentence; anything else is not ours to explain. */
function refusal(err: unknown): InventoryError | null {
  const cause = err instanceof DatabaseError ? err : (err as { cause?: unknown } | null)?.cause;
  if (!(cause instanceof DatabaseError)) return null;
  if (cause.code?.startsWith("22")) return new InventoryError("One of the values is not one the inventory can hold. Check the date and the price.", "invalid");
  if (cause.code === "23505") {
    if (cause.constraint === "inventory_container_acquisitions_once") return new InventoryError(ALREADY_SENT, "conflict");
    if (cause.constraint?.startsWith("inventory_container_acquisitions_") || cause.constraint === "inventory_sourcing_preferences_product_rank") {
      return new InventoryError(CHANGED_SINCE, "conflict");
    }
    return null;
  }
  if (cause.code !== "23514") return null;
  return new InventoryError(cause.message.startsWith("new row") ? "The database refused that combination." : cause.message, "invalid");
}

export type Paperwork = { id: string; name: string | null; contentType: string; byteSize: number; addedAt: Date };

export type PurchaseRecord = {
  id: string;
  /** The record this one corrects; null for the first. */
  supersedes: string | null;
  vendor: { businessId: string; name: string; idCode: string | null } | null;
  acquiredOn: string | null;
  /** As numeric(12,2) prints it, "18.50". */
  price: string | null;
  currency: string | null;
  document: Paperwork | null;
  /** Kept from an imported order line or note; the form does not edit them, and a correction carries them over. */
  orderLineId: string | null;
  note: string | null;
  at: Date;
  byYou: boolean;
};

export type ProductPurchase = {
  vendorName: string | null;
  acquiredOn: string | null;
  price: string | null;
  currency: string | null;
  containerId: string;
  /** How sure the order is: every candidate has a date, some do, or none (then only the order they were recorded in). */
  dated: "all" | "some" | "none";
};

export type ContainerPurchase = {
  product: { id: string; name: string };
  /** The current record's id, or "-" when nothing is recorded yet. Read in the same statement as the records. */
  version: string;
  current: PurchaseRecord | null;
  /** Newest first. */
  history: PurchaseRecord[];
  /** This container's purchase paperwork. */
  paperwork: Paperwork[];
  /** Other purchase paperwork of this business, to attach here too (one invoice, several jars). */
  reusable: (Paperwork & { usedFor: string | null })[];
  lastBought: ProductPurchase | null;
  preferred: { version: string; vendor: { businessId: string; name: string; idCode: string | null } | null; alternatives: string[] };
  /** Companies this business buys from, for the seller field's suggestions. */
  vendors: string[];
  /** The currency to offer first: this container's, else the business's last one, else CAD. */
  currency: string;
};

type RecordRow = {
  id: string;
  container_id: string;
  supersedes_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_code: string | null;
  acquired_on: string | null;
  price: string | null;
  currency: string | null;
  document_id: string | null;
  document_name: string | null;
  document_type: string | null;
  document_size: string | null;
  document_at: string | null;
  order_line_id: string | null;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
  is_current: boolean;
};

/** Every record of one container and which one is current, in one statement (one snapshot). */
const RECORDS = (containerId: string) => sql`
  select a.id, a.container_id, a.supersedes_id, a.vendor_id, dir.name as vendor_name, dir.id_code as vendor_code,
         a.acquired_on::text, a.price::text, a.currency::text, a.document_id,
         d.original_name as document_name, d.content_type as document_type, d.byte_size::text as document_size, d.created_at as document_at,
         a.order_line_id, a.note, a.recorded_by, a.created_at,
         not exists (select 1 from inventory_container_acquisitions b
                      where b.organization_id = a.organization_id and b.supersedes_id = a.id) as is_current
    from inventory_container_acquisitions a
    left join inventory_business_directory dir on dir.organization_id = a.organization_id and dir.business_id = a.vendor_id
    left join inventory_documents d on d.organization_id = a.organization_id and d.id = a.document_id
   where a.container_id = ${containerId}
   order by a.created_at desc, a.id desc`;

function toRecord(r: RecordRow, owner: InventoryOwner): PurchaseRecord {
  return {
    id: r.id,
    supersedes: r.supersedes_id,
    vendor: r.vendor_id ? { businessId: r.vendor_id, name: r.vendor_name ?? "", idCode: r.vendor_code } : null,
    acquiredOn: r.acquired_on,
    price: r.price,
    currency: r.currency,
    document: r.document_id
      ? { id: r.document_id, name: r.document_name, contentType: r.document_type ?? "", byteSize: Number(r.document_size ?? 0), addedAt: when(r.document_at) }
      : null,
    orderLineId: r.order_line_id,
    note: r.note,
    at: when(r.created_at),
    byYou: r.recorded_by === owner.userId,
  };
}

/**
 * The preferred seller's revision: its LATEST rank-1 row for the product,
 * active or retired, and when that row last changed. Rows are retired, never
 * removed, so clearing the preferred seller moves the revision on too — only a
 * product whose preferred seller was never set has "-". A page that showed
 * "none" before someone set it and cleared it again cannot then set it as if
 * nothing had happened.
 */
const PREFERENCE_REVISION = (productId: string) => sql`coalesce((
    select 'p1.' || x.id::text || '.' || (extract(epoch from x.updated_at) * 1000000)::bigint::text
      from inventory_sourcing_preferences x
     where x.product_id = ${productId} and x.rank = 1
     order by x.updated_at desc, x.created_at desc, x.id desc
     limit 1), '-')`;

/** One container's purchase, its product's last purchase and preferred seller. Null when the container is not this business's. */
export async function getContainerPurchase(owner: InventoryOwner, containerId: string): Promise<ContainerPurchase | null> {
  return run(owner, async (tx) => {
    const c = await one<{ product_id: string; product_name: string }>(
      tx,
      sql`select lo.product_id, p.name as product_name
            from inventory_containers c
            join inventory_lots lo on lo.organization_id = c.organization_id and lo.id = c.lot_id
            join inventory_products p on p.organization_id = lo.organization_id and p.id = lo.product_id
           where c.id = ${containerId}`,
    );
    if (!c) return null;

    const records = (await all<RecordRow>(tx, RECORDS(containerId))).map((r) => ({ row: r, record: toRecord(r, owner) }));
    const current = records.find((r) => r.row.is_current)?.record ?? null;

    const paperwork = await all<{ id: string; original_name: string | null; content_type: string; byte_size: string; created_at: string }>(
      tx,
      sql`select d.id, d.original_name, d.content_type, d.byte_size::text, l.created_at
            from inventory_document_links l
            join inventory_documents d on d.organization_id = l.organization_id and d.id = l.document_id
           where l.container_id = ${containerId} and l.role = 'purchase' and d.state = 'stored'
           order by l.created_at desc, d.id`,
    );

    const reusable = await all<{ id: string; original_name: string | null; content_type: string; byte_size: string; created_at: string; used_for: string | null }>(
      tx,
      sql`select d.id, d.original_name, d.content_type, d.byte_size::text, d.created_at,
                 (select p.name from inventory_document_links l2
                    join inventory_containers c2 on c2.organization_id = l2.organization_id and c2.id = l2.container_id
                    join inventory_lots lo2 on lo2.organization_id = c2.organization_id and lo2.id = c2.lot_id
                    join inventory_products p on p.organization_id = lo2.organization_id and p.id = lo2.product_id
                   where l2.document_id = d.id and l2.role = 'purchase'
                   order by l2.created_at limit 1) as used_for
            from inventory_documents d
           where d.state = 'stored'
             and exists (select 1 from inventory_document_links l
                          where l.organization_id = d.organization_id and l.document_id = d.id and l.role = 'purchase')
             and not exists (select 1 from inventory_document_links l
                              where l.organization_id = d.organization_id and l.document_id = d.id and l.container_id = ${containerId})
           order by d.created_at desc, d.id
           limit 8`,
    );

    // The product's purchases: the CURRENT record of each of its containers
    // (a correction is not a purchase), by purchase date; an undated one by
    // when its purchase was first recorded, never by when it was corrected.
    const bought = await all<{
      container_id: string;
      vendor_name: string | null;
      acquired_on: string | null;
      price: string | null;
      currency: string | null;
      dated: number;
      undated: number;
    }>(
      tx,
      sql`with heads as (
            select a.*,
                   (select min(x.created_at) from inventory_container_acquisitions x
                     where x.organization_id = a.organization_id and x.container_id = a.container_id) as first_recorded
              from inventory_container_acquisitions a
              join inventory_containers ct on ct.organization_id = a.organization_id and ct.id = a.container_id
              join inventory_lots lo on lo.organization_id = ct.organization_id and lo.id = ct.lot_id
             where lo.product_id = ${c.product_id}
               and not exists (select 1 from inventory_container_acquisitions b
                                where b.organization_id = a.organization_id and b.supersedes_id = a.id)
               -- Any fact counts (a date alone, an invoice alone); only a record cleared of everything does not.
               and num_nonnulls(a.vendor_id, a.order_line_id, a.document_id, a.acquired_on, a.price, nullif(btrim(a.note), '')) > 0
          )
          select h.container_id, dir.name as vendor_name, h.acquired_on::text, h.price::text, h.currency::text,
                 (select count(*) from heads where acquired_on is not null)::int as dated,
                 (select count(*) from heads where acquired_on is null)::int as undated
            from heads h
            left join inventory_business_directory dir on dir.organization_id = h.organization_id and dir.business_id = h.vendor_id
           order by h.acquired_on desc nulls last, h.first_recorded desc, h.id desc
           limit 1`,
    );

    // The revision and the preferences it describes, in one statement (one snapshot).
    const preferences = await all<{ revision: string; rank: number | null; vendor_id: string | null; name: string | null; id_code: string | null }>(
      tx,
      sql`select r.revision, sp.rank, sp.vendor_id, dir.name, dir.id_code
            from (select ${PREFERENCE_REVISION(c.product_id)} as revision) r
            left join inventory_sourcing_preferences sp on sp.product_id = ${c.product_id} and sp.active
            left join inventory_business_directory dir on dir.organization_id = sp.organization_id and dir.business_id = sp.vendor_id
           order by sp.rank, sp.created_at`,
    );
    const first = preferences.find((p) => p.rank === 1);

    const vendors = await all<{ name: string }>(
      tx,
      sql`select distinct dir.name from inventory_business_directory dir where dir.is_vendor order by dir.name limit 200`,
    );
    const lastCurrency = await one<{ currency: string }>(
      tx,
      sql`select currency::text from inventory_container_acquisitions where currency is not null order by created_at desc, id desc limit 1`,
    );

    const b = bought[0];
    return {
      product: { id: c.product_id, name: c.product_name },
      version: current?.id ?? "-",
      current,
      history: records.map((r) => r.record),
      paperwork: paperwork.map((p) => ({ id: p.id, name: p.original_name, contentType: p.content_type, byteSize: Number(p.byte_size), addedAt: when(p.created_at) })),
      reusable: reusable.map((p) => ({
        id: p.id,
        name: p.original_name,
        contentType: p.content_type,
        byteSize: Number(p.byte_size),
        addedAt: when(p.created_at),
        usedFor: p.used_for,
      })),
      lastBought: b
        ? {
            vendorName: b.vendor_name,
            acquiredOn: b.acquired_on,
            price: b.price,
            currency: b.currency,
            containerId: b.container_id,
            dated: b.undated === 0 ? "all" : b.dated === 0 ? "none" : "some",
          }
        : null,
      preferred: {
        version: preferences[0]?.revision ?? "-",
        vendor: first?.vendor_id ? { businessId: first.vendor_id, name: first.name ?? "", idCode: first.id_code } : null,
        alternatives: preferences.filter((p) => p.rank !== null && p.rank > 1 && p.vendor_id !== first?.vendor_id && p.name).map((p) => p.name!),
      },
      vendors: vendors.map((v) => v.name),
      currency: current?.currency ?? lastCurrency?.currency ?? "CAD",
    };
  });
}

/* ------------------------------------------------------------------ */
/* Saving a container's purchase                                       */
/* ------------------------------------------------------------------ */

/** What a record says, as the form says it: the seller by name, the price as numeric prints it, no currency without a price. */
function sameFacts(r: RecordRow, input: PurchaseInput): boolean {
  const vendorSame = input.vendor === null ? r.vendor_id === null : r.vendor_id !== null && (r.vendor_name ?? "").toLowerCase() === input.vendor.toLowerCase();
  return (
    vendorSame &&
    r.acquired_on === input.acquiredOn &&
    r.price === input.price &&
    r.currency === (input.price === null ? null : input.currency) &&
    r.document_id === input.documentId
  );
}

const saysNothing = (input: PurchaseInput) =>
  input.vendor === null && input.acquiredOn === null && input.price === null && input.documentId === null;

/**
 * Save what is known about how this container was bought.
 *
 * Under the container's row lock: a request already recorded (its key) is
 * answered as it was — and refused if it now says something else; a page
 * that showed another current record is refused unless it says exactly what
 * is now recorded; saying what is already recorded changes nothing. Otherwise
 * a new full record supersedes the current one: the fields the form does not
 * edit are carried over, and a field left empty is recorded as unknown.
 */
export async function saveContainerPurchase(owner: InventoryOwner, input: PurchaseInput): Promise<{ changed: boolean }> {
  const key = `purchase:${input.containerId}:${input.requestKey}`;
  try {
    return await run(owner, async (tx) => {
      const locked = await one<{ id: string }>(tx, sql`select id from inventory_containers where id = ${input.containerId} for update`);
      if (!locked) throw new InventoryError("That item is not in this inventory.", "not_found");

      // After the lock, in their own statement: every record committed before it.
      const rows = await all<RecordRow>(tx, RECORDS(input.containerId));
      const head = rows.find((r) => r.is_current) ?? null;

      const sent = await one<{ id: string }>(tx, sql`select id from inventory_container_acquisitions where idempotency_key = ${key}`);
      if (sent) {
        const it = rows.find((r) => r.id === sent.id);
        if (it && sameFacts(it, input)) return { changed: false };
        throw new InventoryError(ALREADY_SENT, "conflict");
      }

      const unchanged = head ? sameFacts(head, input) : saysNothing(input);
      if ((head?.id ?? "-") !== input.version) {
        if (unchanged) return { changed: false };
        throw new InventoryError(CHANGED_SINCE, "conflict");
      }
      if (unchanged) {
        if (!head) throw new InventoryError("Fill in at least one thing you know: the seller, the date, the price or the invoice.", "invalid", "vendor");
        return { changed: false };
      }

      const vendorId =
        input.vendor === null
          ? null
          : head?.vendor_id && (head.vendor_name ?? "").toLowerCase() === input.vendor.toLowerCase()
            ? head.vendor_id
            : await vendorFor(tx, owner, input.vendor);
      if (input.documentId !== null) await attachPaperwork(tx, owner, input.containerId, input.documentId);

      await tx.execute(
        sql`insert into inventory_container_acquisitions
              (organization_id, container_id, supersedes_id, vendor_id, order_line_id, document_id,
               acquired_on, price, currency, note, idempotency_key, recorded_by)
            values (${owner.organizationId}, ${input.containerId}, ${head?.id ?? null}, ${vendorId}, ${head?.order_line_id ?? null},
                    ${input.documentId}, ${input.acquiredOn}, ${input.price}, ${input.price === null ? null : input.currency},
                    ${head?.note ?? null}, ${key}, ${owner.userId})`,
      );
      return { changed: true };
    });
  } catch (err) {
    throw refusal(err) ?? err;
  }
}

/**
 * The seller: a company this business already deals with by that name, now
 * marked as one it buys from, or a new listed company with its own 10XiD iD.
 * Only this business's own relationships are searched, and the maker of a
 * product is never assumed to be its seller — the name was typed here. One
 * name at a time per business, so two saves cannot list the same company twice.
 */
async function vendorFor(tx: Transaction, owner: InventoryOwner, name: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`inventory-company:${owner.organizationId}:${name.toLowerCase()}`}, 0))`);
  const found = await one<{ id: string; is_vendor: boolean }>(
    tx,
    sql`select b.id, b.is_vendor
          from inventory_businesses b
          join organizations o on o.id = b.company_id
         where lower(o.name) = lower(${name})
         order by b.created_at
         limit 1`,
  );
  if (found) {
    if (!found.is_vendor) await tx.execute(sql`update inventory_businesses set is_vendor = true, updated_at = now() where id = ${found.id}`);
    return found.id;
  }
  const company = await one<{ company_id: string }>(tx, sql`select company_id from list_company(${name})`);
  const made = await one<{ id: string }>(
    tx,
    sql`insert into inventory_businesses (organization_id, company_id, is_vendor)
        values (${owner.organizationId}, ${company!.company_id}, true)
        returning id`,
  );
  return made!.id;
}

/** The paperwork a record cites: this business's, arrived, and attached to the container as purchase paperwork. */
async function attachPaperwork(tx: Transaction, owner: InventoryOwner, containerId: string, documentId: string): Promise<void> {
  const doc = await one<{ state: string }>(tx, sql`select state from inventory_documents where id = ${documentId}`);
  if (!doc) throw new InventoryError("That invoice or receipt is not in this inventory.", "invalid", "documentId");
  if (doc.state !== "stored") throw new InventoryError("That invoice or receipt has not finished arriving. Send it again.", "invalid", "documentId");
  await tx.execute(
    sql`insert into inventory_document_links (organization_id, document_id, container_id, role)
        values (${owner.organizationId}, ${documentId}, ${containerId}, 'purchase')
        on conflict do nothing`,
  );
}

/* ------------------------------------------------------------------ */
/* Paperwork uploads                                                   */
/* ------------------------------------------------------------------ */

export type PaperworkRegistration = {
  documentId: string;
  storageKey: string;
  contentType: string;
  state: "pending" | "stored" | "failed";
  created: boolean;
};

/**
 * Make (or find, by content) the document for an invoice or receipt of this
 * container. Linked only once the file is stored (linkPaperwork), so the page
 * never lists paperwork that did not arrive; the same bytes again finish an
 * upload that failed.
 */
export async function registerPaperwork(
  owner: InventoryOwner,
  containerId: string,
  file: { sha256: Buffer; contentType: string; byteSize: number; originalName: string | null; storageKey: string },
): Promise<PaperworkRegistration> {
  return run(owner, async (tx) => {
    const c = await one<{ id: string }>(tx, sql`select id from inventory_containers where id = ${containerId}`);
    if (!c) throw new InventoryError("That item is not in this inventory.", "not_found");
    type Doc = { id: string; storage_key: string; content_type: string; state: PaperworkRegistration["state"] };
    const inserted = await one<Doc>(
      tx,
      sql`insert into inventory_documents (organization_id, kind, content_type, storage_key, byte_size, sha256, original_name, uploaded_by)
          values (${owner.organizationId}, 'invoice', ${file.contentType}, ${file.storageKey}, ${file.byteSize}, ${file.sha256},
                  ${file.originalName}, ${owner.userId})
          on conflict (organization_id, sha256) do nothing
          returning id, storage_key, content_type, state`,
    );
    const doc =
      inserted ??
      (await one<Doc>(
        tx,
        sql`select id, storage_key, content_type, state from inventory_documents
             where organization_id = ${owner.organizationId} and sha256 = ${file.sha256}`,
      ));
    if (!doc) throw new Error("A document with this content was neither made nor found.");
    return { documentId: doc.id, storageKey: doc.storage_key, contentType: doc.content_type, state: doc.state, created: !!inserted };
  });
}

/** Attach stored paperwork to the container; attaching it again changes nothing. */
export async function linkPaperwork(owner: InventoryOwner, containerId: string, documentId: string): Promise<Paperwork> {
  return run(owner, async (tx) => {
    await attachPaperwork(tx, owner, containerId, documentId);
    const d = await one<{ id: string; original_name: string | null; content_type: string; byte_size: string; created_at: string }>(
      tx,
      sql`select d.id, d.original_name, d.content_type, d.byte_size::text, l.created_at
            from inventory_document_links l
            join inventory_documents d on d.organization_id = l.organization_id and d.id = l.document_id
           where l.document_id = ${documentId} and l.container_id = ${containerId}
           order by l.created_at limit 1`,
    );
    return { id: d!.id, name: d!.original_name, contentType: d!.content_type, byteSize: Number(d!.byte_size), addedAt: when(d!.created_at) };
  });
}

/* ------------------------------------------------------------------ */
/* The preferred seller                                                */
/* ------------------------------------------------------------------ */

/**
 * Where this container's product is bought from next time: the product's
 * rank-1 sourcing preference. Its own version and lock (the product's row),
 * so a purchase form never changes it and a stale page cannot overwrite it.
 * A change retires the old preference (kept, inactive) and adds the new one;
 * the alternatives (rank 2 and on) stay as they are. Nothing is recorded when
 * it already says that.
 */
export async function savePreferredVendor(owner: InventoryOwner, input: PreferredInput): Promise<{ changed: boolean }> {
  try {
    return await run(owner, async (tx) => {
      const c = await one<{ product_id: string }>(
        tx,
        sql`select lo.product_id from inventory_containers c
              join inventory_lots lo on lo.organization_id = c.organization_id and lo.id = c.lot_id
             where c.id = ${input.containerId}`,
      );
      if (!c) throw new InventoryError("That item is not in this inventory.", "not_found");
      await tx.execute(sql`select id from inventory_products where id = ${c.product_id} for update`);

      // After the product's lock, in one statement: the revision and the current preferred seller.
      const now = await one<{ revision: string; id: string | null; name: string | null }>(
        tx,
        sql`select r.revision, sp.id, dir.name
              from (select ${PREFERENCE_REVISION(c.product_id)} as revision) r
              left join inventory_sourcing_preferences sp on sp.product_id = ${c.product_id} and sp.active and sp.rank = 1
              left join inventory_business_directory dir on dir.organization_id = sp.organization_id and dir.business_id = sp.vendor_id`,
      );
      const cur = now?.id ? { id: now.id, name: now.name } : null;
      // Asking for what is already so changes nothing, whatever page it came from.
      const same = cur ? input.vendor !== null && (cur.name ?? "").toLowerCase() === input.vendor.toLowerCase() : input.vendor === null;
      if (same) return { changed: false };
      if ((now?.revision ?? "-") !== input.version) throw new InventoryError(CHANGED_SINCE, "conflict");

      if (cur) await tx.execute(sql`update inventory_sourcing_preferences set active = false, updated_at = clock_timestamp() where id = ${cur.id}`);
      if (input.vendor !== null) {
        const vendorId = await vendorFor(tx, owner, input.vendor);
        await tx.execute(
          sql`insert into inventory_sourcing_preferences (organization_id, product_id, rank, vendor_id, updated_at)
              values (${owner.organizationId}, ${c.product_id}, 1, ${vendorId}, clock_timestamp())`,
        );
      }
      await tx.execute(
        sql`insert into audit_events (organization_id, actor_user_id, action, target)
            values (${owner.organizationId}, ${owner.userId}, 'inventory.product.preferred_vendor_changed', ${`inventory_products:${c.product_id}`})`,
      );
      return { changed: true };
    });
  } catch (err) {
    throw refusal(err) ?? err;
  }
}
