import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { DatabaseError } from "pg";
import { inOwnerTransaction, type Transaction } from "./connection";
import {
  BASE_UNIT,
  UNITS,
  normalizeUnit,
  type ExtractedFieldName,
  type OpeningPlan,
  type ReviewInput,
} from "@/lib/inventory/review";

/**
 * A business's inventory as the capture screens use it (login's 0048).
 *
 * Every read and write runs in the owner transaction, so row-level security
 * filters by business underneath whatever is asked here: another business's
 * capture, photo or container is not found rather than refused. Raw SQL rather
 * than the query builder, because most of what matters here is the database's
 * own rules — confirm-once, the ledger's basis rules, idempotent links — and
 * those read best as the statements they are.
 *
 * The flow:
 *
 *   createCapture         one sitting in front of one physical container
 *   registerCapturePhoto  a file is ONE document per business (by its hash):
 *                         uploading it again — a retry, or the same label
 *                         photo for a second jar — reuses that document and
 *                         links it to this capture as well
 *   begin/finish/failExtraction   what a model read, field by field
 *   confirmCapture        product, lot, container, weighing and the ONE
 *                         opening event, in one transaction, once
 *   listInventory         every container and what it holds, unknown as
 *                         unknown
 */

export type InventoryOwner = { organizationId: string; userId: string };

export class InventoryError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "closed" | "saved" | "invalid" | "unsent",
    readonly field?: string,
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

type Row = Record<string, unknown>;

async function all<T extends Row>(tx: Transaction, query: SQL): Promise<T[]> {
  return (await tx.execute<T>(query)).rows as T[];
}

async function one<T extends Row>(tx: Transaction, query: SQL): Promise<T | undefined> {
  return (await all<T>(tx, query))[0];
}

const run = <T>(owner: InventoryOwner, fn: (tx: Transaction) => Promise<T>) =>
  inOwnerTransaction(owner.organizationId, owner.userId, fn);

/**
 * A refusal written by one of 0048's triggers or checks, as a sentence. Drizzle wraps the driver's error.
 * A value the database cannot hold at all (class 22: a date that does not exist, a number out of range)
 * is a refusal too, never a 500 — whose log would carry every parameter, the form's text included.
 */
function refusal(err: unknown): InventoryError | null {
  const cause = err instanceof DatabaseError ? err : (err as { cause?: unknown } | null)?.cause;
  if (!(cause instanceof DatabaseError)) return null;
  if (cause.code?.startsWith("22")) return new InventoryError("One of the values is not one the inventory can hold. Check the dates and numbers.", "invalid");
  if (cause.code !== "23514") return null;
  return new InventoryError(cause.message.startsWith("new row") ? "The database refused that combination." : cause.message, "invalid");
}

/** Timestamps from raw SQL arrive as text (the driver leaves parsing to Drizzle's columns). */
function when(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function whenOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : when(value);
}

/* ------------------------------------------------------------------ */
/* Captures                                                            */
/* ------------------------------------------------------------------ */

export async function createCapture(owner: InventoryOwner): Promise<string> {
  return run(owner, async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      sql`insert into inventory_captures (organization_id, created_by)
          values (${owner.organizationId}, ${owner.userId})
          returning id`,
    );
    return row!.id;
  });
}

export type OpenCapture = { id: string; createdAt: Date; photos: number };

/** Items started and neither saved nor discarded, newest first. */
export async function openCaptures(owner: InventoryOwner): Promise<OpenCapture[]> {
  const rows = await run(owner, (tx) =>
    all<{ id: string; created_at: string; photos: number }>(
      tx,
      sql`select c.id, c.created_at,
                 (select count(*) from inventory_document_links l
                   where l.organization_id = c.organization_id and l.capture_id = c.id)::int as photos
            from inventory_captures c
           where c.status = 'open'
           order by c.created_at desc
           limit 20`,
    ),
  );
  return rows.map((r) => ({ id: r.id, createdAt: when(r.created_at), photos: Number(r.photos) }));
}

export async function abandonCapture(owner: InventoryOwner, captureId: string): Promise<boolean> {
  const row = await run(owner, (tx) =>
    one<{ id: string }>(
      tx,
      sql`update inventory_captures set status = 'abandoned', updated_at = now()
           where id = ${captureId} and status = 'open'
          returning id`,
    ),
  );
  return !!row;
}

export type CapturePhoto = {
  id: string;
  contentType: string;
  byteSize: number;
  state: "pending" | "stored" | "failed";
  originalName: string | null;
  /** Containers this same file is already evidence for. */
  evidenceFor: { containerId: string; productName: string; createdAt: Date }[];
};

export type CaptureField = {
  field: ExtractedFieldName | string;
  rawText: string | null;
  value: unknown;
  confidence: number | null;
  documentId: string | null;
};

export type CaptureView = {
  id: string;
  status: "open" | "confirmed" | "abandoned";
  createdAt: Date;
  confirmedAt: Date | null;
  containerId: string | null;
  photos: CapturePhoto[];
  extraction: {
    id: string;
    engine: string;
    status: string;
    error: string | null;
    finishedAt: Date | null;
    fields: CaptureField[];
  } | null;
  saved: { containerId: string; productName: string } | null;
};

export async function getCapture(owner: InventoryOwner, captureId: string): Promise<CaptureView | null> {
  return run(owner, async (tx) => {
    const capture = await one<{
      id: string;
      status: CaptureView["status"];
      created_at: string;
      confirmed_at: string | null;
      container_id: string | null;
    }>(tx, sql`select id, status, created_at, confirmed_at, container_id from inventory_captures where id = ${captureId}`);
    if (!capture) return null;

    const photos = await all<{
      id: string;
      content_type: string;
      byte_size: string;
      state: CapturePhoto["state"];
      original_name: string | null;
    }>(
      tx,
      sql`select d.id, d.content_type, d.byte_size::text, d.state, d.original_name
            from inventory_document_links l
            join inventory_documents d on d.organization_id = l.organization_id and d.id = l.document_id
           where l.capture_id = ${captureId}
           order by l.created_at, d.id`,
    );

    // Where else each of these files is evidence: other containers.
    const uses = await all<{ document_id: string; container_id: string; product_name: string; created_at: string }>(
      tx,
      sql`select l2.document_id, c.id as container_id, p.name as product_name, c.created_at
            from inventory_document_links l1
            join inventory_document_links l2
              on l2.organization_id = l1.organization_id and l2.document_id = l1.document_id and l2.container_id is not null
            join inventory_containers c on c.organization_id = l2.organization_id and c.id = l2.container_id
            join inventory_lots lo on lo.organization_id = c.organization_id and lo.id = c.lot_id
            join inventory_products p on p.organization_id = lo.organization_id and p.id = lo.product_id
           where l1.capture_id = ${captureId}
           order by c.created_at`,
    );

    const extraction = await one<{
      id: string;
      engine: string;
      status: string;
      error: string | null;
      finished_at: string | null;
    }>(
      tx,
      sql`select id, engine, status, error, finished_at from inventory_extractions
           where capture_id = ${captureId}
           order by created_at desc, id desc
           limit 1`,
    );
    const fields = extraction
      ? await all<{ field: string; raw_text: string | null; value: unknown; confidence: string | null; document_id: string | null }>(
          tx,
          sql`select field, raw_text, value, confidence::text, document_id
                from inventory_extracted_fields
               where extraction_id = ${extraction.id}
               order by field, id`,
        )
      : [];

    const saved = capture.container_id
      ? await one<{ product_name: string }>(
          tx,
          sql`select p.name as product_name
                from inventory_containers c
                join inventory_lots lo on lo.organization_id = c.organization_id and lo.id = c.lot_id
                join inventory_products p on p.organization_id = lo.organization_id and p.id = lo.product_id
               where c.id = ${capture.container_id}`,
        )
      : undefined;

    return {
      id: capture.id,
      status: capture.status,
      createdAt: when(capture.created_at),
      confirmedAt: whenOrNull(capture.confirmed_at),
      containerId: capture.container_id,
      photos: photos.map((p) => ({
        id: p.id,
        contentType: p.content_type,
        byteSize: Number(p.byte_size),
        state: p.state,
        originalName: p.original_name,
        evidenceFor: uses
          .filter((u) => u.document_id === p.id && u.container_id !== capture.container_id)
          .map((u) => ({ containerId: u.container_id, productName: u.product_name, createdAt: when(u.created_at) })),
      })),
      extraction: extraction
        ? {
            id: extraction.id,
            engine: extraction.engine,
            status: extraction.status,
            error: extraction.error,
            finishedAt: whenOrNull(extraction.finished_at),
            fields: fields.map((f) => ({
              field: f.field,
              rawText: f.raw_text,
              value: f.value,
              confidence: f.confidence === null ? null : Number(f.confidence),
              documentId: f.document_id,
            })),
          }
        : null,
      saved: capture.container_id && saved ? { containerId: capture.container_id, productName: saved.product_name } : null,
    };
  });
}

export type ProductChoice = {
  id: string;
  name: string;
  brand: string | null;
  packageQuantity: string | null;
  packageUnit: string | null;
  gtin: string | null;
  /** 2: same barcode, 1: same name, 0: neither. */
  match: number;
};

/** This business's products for the "is it one we have?" choice, likely matches first. */
export async function productChoices(
  owner: InventoryOwner,
  hint: { gtin?: string; name?: string },
): Promise<ProductChoice[]> {
  const rows = await run(owner, (tx) =>
    all<{
      id: string;
      name: string;
      brand: string | null;
      package_quantity: string | null;
      package_unit: string | null;
      gtin: string | null;
      match: number;
    }>(
      tx,
      sql`select p.id, p.name, b.name as brand, p.package_quantity::text, p.package_unit, p.gtin,
                 (case when ${hint.gtin ?? null}::text is not null and p.gtin = ${hint.gtin ?? null}::text then 2
                       when ${hint.name ?? null}::text is not null and lower(p.name) = lower(${hint.name ?? null}::text) then 1
                       else 0 end)::int as match
            from inventory_products p
            left join inventory_brands b on b.organization_id = p.organization_id and b.id = p.brand_id
           where p.archived_at is null
           order by match desc, lower(p.name), p.id
           limit 200`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    packageQuantity: r.package_quantity,
    packageUnit: r.package_unit,
    gtin: r.gtin,
    match: r.match,
  }));
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */

export type PhotoRegistration = {
  documentId: string;
  storageKey: string;
  contentType: string;
  state: "pending" | "stored" | "failed";
  /** False when this file was already a document of this business. */
  created: boolean;
  /** Set when the photo was added to an item already saved: the container it is now evidence for. */
  addedToSaved: string | null;
};

/**
 * Make (or find) the document for this file and link it to the capture.
 *
 * The capture must still be open: a capture being confirmed holds its row, so
 * a photo arriving at the same moment waits and is then refused rather than
 * linked to an item already saved — with code "saved", so the phone keeps it.
 *
 * Unless `afterSave`: a photo that was still on a phone (offline, never sent)
 * when the item was saved from somewhere else can be added afterwards, as
 * evidence only. It is linked to the capture and to the container, lot and
 * product the save made; nothing in the stock changes, and the owner's
 * decision to add it is written to the audit log once per container.
 */
export async function registerCapturePhoto(
  owner: InventoryOwner,
  captureId: string,
  file: {
    sha256: Buffer;
    contentType: string;
    byteSize: number;
    originalName: string | null;
    capturedAt: Date | null;
    /** Used only when the file is new here. */
    storageKey: string;
  },
  options: { afterSave?: boolean } = {},
): Promise<PhotoRegistration> {
  return run(owner, async (tx) => {
    const capture = await one<{ status: string; container_id: string | null }>(
      tx,
      sql`select status, container_id from inventory_captures where id = ${captureId} for share`,
    );
    if (!capture) throw new InventoryError("That item is not here.", "not_found");
    if (capture.status === "abandoned") throw new InventoryError("This item was discarded.", "closed");
    if (capture.status === "confirmed" && !options.afterSave) {
      throw new InventoryError("This item was saved before this photo arrived. It can be added to the saved item.", "saved");
    }

    type Doc = { id: string; storage_key: string; content_type: string; state: PhotoRegistration["state"] };
    const inserted = await one<Doc>(
      tx,
      sql`insert into inventory_documents
            (organization_id, capture_id, kind, content_type, storage_key, byte_size, sha256, original_name, captured_at, uploaded_by)
          values
            (${owner.organizationId}, ${captureId}, 'photo', ${file.contentType}, ${file.storageKey}, ${file.byteSize},
             ${file.sha256}, ${file.originalName}, ${file.capturedAt}, ${owner.userId})
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

    await tx.execute(
      sql`insert into inventory_document_links (organization_id, document_id, capture_id, role)
          values (${owner.organizationId}, ${doc.id}, ${captureId}, 'photo')
          on conflict do nothing`,
    );

    let addedToSaved: string | null = null;
    if (capture.status === "confirmed" && capture.container_id) {
      const saved = await one<{ lot_id: string; product_id: string }>(
        tx,
        sql`select c.lot_id, l.product_id from inventory_containers c
              join inventory_lots l on l.organization_id = c.organization_id and l.id = c.lot_id
             where c.id = ${capture.container_id}`,
      );
      if (!saved) throw new InventoryError("That item is not here.", "not_found");
      const linked = await one<{ id: string }>(
        tx,
        sql`insert into inventory_document_links (organization_id, document_id, container_id, role)
            values (${owner.organizationId}, ${doc.id}, ${capture.container_id}, 'label')
            on conflict do nothing returning id`,
      );
      for (const [column, id] of [
        ["lot_id", saved.lot_id],
        ["product_id", saved.product_id],
      ] as const) {
        await tx.execute(
          sql`insert into inventory_document_links (organization_id, document_id, ${sql.raw(column)}, role)
              values (${owner.organizationId}, ${doc.id}, ${id}, 'label')
              on conflict do nothing`,
        );
      }
      if (linked) {
        await tx.execute(
          sql`insert into audit_events (organization_id, actor_user_id, action, target)
              values (${owner.organizationId}, ${owner.userId}, 'inventory.evidence.added_after_save',
                      ${`inventory_containers:${capture.container_id}`})`,
        );
      }
      addedToSaved = capture.container_id;
    }

    return {
      documentId: doc.id,
      storageKey: doc.storage_key,
      contentType: doc.content_type,
      state: doc.state,
      created: !!inserted,
      addedToSaved,
    };
  });
}

/**
 * Record how an upload of the file ended. Stored is final: two uploads of the
 * same bytes can overlap (a retry, a second tab), and one that fails AFTER
 * another has stored the file must not mark it failed — the file is there.
 */
export async function markDocument(
  owner: InventoryOwner,
  documentId: string,
  state: "stored" | "failed",
  error: string | null,
): Promise<void> {
  await run(owner, (tx) =>
    tx.execute(
      sql`update inventory_documents set state = ${state}, error = ${error}, updated_at = now()
           where id = ${documentId} and (${state} = 'stored' or state <> 'stored')`,
    ),
  );
}

/**
 * Take a photo out of an item that is still open — the way on when a photo
 * never finished arriving (its phone is gone, or it keeps failing). The file
 * itself is kept, and so is anything else it is evidence for.
 */
export async function removeCapturePhoto(owner: InventoryOwner, captureId: string, documentId: string): Promise<void> {
  await run(owner, async (tx) => {
    const capture = await one<{ status: string }>(tx, sql`select status from inventory_captures where id = ${captureId} for update`);
    if (!capture) throw new InventoryError("That item is not here.", "not_found");
    if (capture.status !== "open") throw new InventoryError("This item is no longer open.", "closed");
    await tx.execute(
      sql`delete from inventory_document_links where capture_id = ${captureId} and document_id = ${documentId}`,
    );
  });
}

/** The containers a document is already evidence for. */
export async function documentEvidence(
  owner: InventoryOwner,
  documentId: string,
): Promise<{ containerId: string; productName: string; createdAt: Date }[]> {
  const rows = await run(owner, (tx) =>
    all<{ container_id: string; product_name: string; created_at: string }>(
      tx,
      sql`select c.id as container_id, p.name as product_name, c.created_at
            from inventory_document_links l
            join inventory_containers c on c.organization_id = l.organization_id and c.id = l.container_id
            join inventory_lots lo on lo.organization_id = c.organization_id and lo.id = c.lot_id
            join inventory_products p on p.organization_id = lo.organization_id and p.id = lo.product_id
           where l.document_id = ${documentId} and l.container_id is not null
           order by c.created_at`,
    ),
  );
  return rows.map((r) => ({ containerId: r.container_id, productName: r.product_name, createdAt: when(r.created_at) }));
}

/** A stored file of this business, for the image route. Null when it is not this business's or not stored. */
export async function documentForDownload(
  owner: InventoryOwner,
  documentId: string,
): Promise<{ storageKey: string; contentType: string; byteSize: number } | null> {
  const row = await run(owner, (tx) =>
    one<{ storage_key: string; content_type: string; byte_size: string; state: string }>(
      tx,
      sql`select storage_key, content_type, byte_size::text, state from inventory_documents where id = ${documentId}`,
    ),
  );
  if (!row || row.state !== "stored") return null;
  return { storageKey: row.storage_key, contentType: row.content_type, byteSize: Number(row.byte_size) };
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

/** The capture's stored photos, in the order they were added. */
export async function captureImages(
  owner: InventoryOwner,
  captureId: string,
): Promise<{ documentId: string; storageKey: string; contentType: string }[]> {
  const rows = await run(owner, (tx) =>
    all<{ id: string; storage_key: string; content_type: string }>(
      tx,
      sql`select d.id, d.storage_key, d.content_type
            from inventory_document_links l
            join inventory_documents d on d.organization_id = l.organization_id and d.id = l.document_id
           where l.capture_id = ${captureId} and d.state = 'stored'
           order by l.created_at, d.id`,
    ),
  );
  return rows.map((r) => ({ documentId: r.id, storageKey: r.storage_key, contentType: r.content_type }));
}

export async function beginExtraction(owner: InventoryOwner, captureId: string, engine: string): Promise<string> {
  return run(owner, async (tx) => {
    const capture = await one<{ status: string }>(tx, sql`select status from inventory_captures where id = ${captureId} for share`);
    if (!capture) throw new InventoryError("That item is not here.", "not_found");
    if (capture.status !== "open") throw new InventoryError("This item is no longer open.", "closed");
    const row = await one<{ id: string }>(
      tx,
      sql`insert into inventory_extractions (organization_id, capture_id, engine, status, started_at)
          values (${owner.organizationId}, ${captureId}, ${engine}, 'running', now())
          returning id`,
    );
    return row!.id;
  });
}

export type ExtractedFieldRow = {
  field: ExtractedFieldName;
  rawText: string | null;
  value: unknown;
  confidence: number | null;
  documentId: string | null;
  locator: Record<string, unknown> | null;
};

export async function finishExtraction(
  owner: InventoryOwner,
  extractionId: string,
  rawOutput: unknown,
  fields: ExtractedFieldRow[],
): Promise<void> {
  await run(owner, async (tx) => {
    for (const f of fields) {
      await tx.execute(
        sql`insert into inventory_extracted_fields
              (organization_id, extraction_id, document_id, field, raw_text, value, source_locator, confidence)
            values
              (${owner.organizationId}, ${extractionId}, ${f.documentId}, ${f.field}, ${f.rawText},
               ${JSON.stringify(f.value ?? null)}::jsonb, ${f.locator ? JSON.stringify(f.locator) : null}::jsonb, ${f.confidence})`,
      );
    }
    await tx.execute(
      sql`update inventory_extractions
             set status = 'needs_review', raw_output = ${JSON.stringify(rawOutput ?? null)}::jsonb, finished_at = now()
           where id = ${extractionId}`,
    );
  });
}

export async function failExtraction(owner: InventoryOwner, extractionId: string, error: string, rawOutput?: unknown): Promise<void> {
  await run(owner, (tx) =>
    tx.execute(
      sql`update inventory_extractions
             set status = 'failed', error = ${error.slice(0, 1000)},
                 raw_output = ${rawOutput === undefined ? null : JSON.stringify(rawOutput)}::jsonb,
                 finished_at = now()
           where id = ${extractionId}`,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Confirming                                                          */
/* ------------------------------------------------------------------ */

export type ConfirmResult = { containerId: string; created: boolean };

/**
 * Save a reviewed capture as one container with its one opening event.
 *
 * One transaction, with the capture's row locked: a second press, a retried
 * request or a second tab waits for the first and then finds the container it
 * made — nothing is created twice. Every part of it is checked again by the
 * database (0048): the opening's basis, the label weight only for a sealed
 * package, a weighed amount only from a scale's net with a weighed tare.
 */
export async function confirmCapture(owner: InventoryOwner, input: ReviewInput, plan: OpeningPlan): Promise<ConfirmResult> {
  try {
    return await run(owner, async (tx) => {
      const capture = await one<{ status: string; container_id: string | null }>(
        tx,
        sql`select status, container_id from inventory_captures where id = ${input.captureId} for update`,
      );
      if (!capture) throw new InventoryError("That item is not here.", "not_found");
      if (capture.status === "confirmed") return { containerId: capture.container_id!, created: false };
      if (capture.status !== "open") throw new InventoryError("This item was discarded.", "closed");

      // Every photo of the item must have arrived: saved first, a photo still
      // on its way could never be added afterwards. Checked here, under the
      // capture's lock, whatever the screen did — another tab, another phone.
      const unsent = await one<{ n: number }>(
        tx,
        sql`select count(*)::int as n
              from inventory_document_links l
              join inventory_documents d on d.organization_id = l.organization_id and d.id = l.document_id
             where l.capture_id = ${input.captureId} and d.state <> 'stored'`,
      );
      if (unsent && unsent.n > 0) {
        throw new InventoryError(
          `${unsent.n === 1 ? "A photo of this item has" : `${unsent.n} photos of this item have`} not finished arriving. ` +
            "Send again from the phone that took it, or remove it from this item, then save.",
          "unsent",
        );
      }

      const productId = input.product === "new" ? await newProduct(tx, owner, input, plan) : await existingProduct(tx, input.product);
      const lotId = await lotFor(tx, owner, productId, input);
      const locationId = input.location ? await locationFor(tx, owner, input.location) : null;
      const tare = plan.measurement?.tareG && plan.measurement.tareBasis ? { g: plan.measurement.tareG, basis: plan.measurement.tareBasis } : null;

      const container = await one<{ id: string }>(
        tx,
        sql`insert into inventory_containers
              (organization_id, lot_id, location_id, status, dimension, nominal_quantity, nominal_unit,
               tare_g, tare_basis, notes, created_by)
            values
              (${owner.organizationId}, ${lotId}, ${locationId}, ${input.status}, ${plan.dimension},
               ${plan.nominal?.quantity ?? null}::numeric, ${plan.nominal?.unit ?? null},
               ${tare?.g ?? null}::numeric, ${tare?.basis ?? "unknown"}, ${input.notes ?? null}, ${owner.userId})
            returning id`,
      );
      const containerId = container!.id;

      // The capture names its container before the ledger event that names
      // the capture: 0048 checks the two agree.
      await tx.execute(
        sql`update inventory_captures
               set status = 'confirmed', container_id = ${containerId}, outcome = 'new_container',
                   confirmed_by = ${owner.userId}, confirmed_at = now(), updated_at = now()
             where id = ${input.captureId}`,
      );

      let measurement: { id: string; net_g: string | null } | undefined;
      if (plan.measurement) {
        const m = plan.measurement;
        measurement = await one<{ id: string; net_g: string | null }>(
          tx,
          sql`insert into inventory_measurements
                (organization_id, container_id, gross_g, tare_g, tare_basis, net_g, method, confidence, measured_by)
              values
                (${owner.organizationId}, ${containerId}, ${m.grossG}::numeric, ${m.tareG}::numeric, ${m.tareBasis},
                 case when ${m.tareG}::numeric is null then null else ${m.grossG}::numeric - ${m.tareG}::numeric end,
                 'scale', ${m.confidence}, ${owner.userId})
              returning id, net_g::text`,
        );
      }

      const o = plan.opening;
      const quantity = o.quantity === "net" ? (measurement?.net_g ?? null) : o.quantity;
      if (o.quantity === "net" && quantity === null) throw new Error("A weighed opening needs the weighing's net.");
      await tx.execute(
        sql`insert into inventory_movements
              (organization_id, container_id, kind, quantity, unit, basis, capture_id, measurement_id, idempotency_key, recorded_by)
            values
              (${owner.organizationId}, ${containerId}, 'opening', ${quantity}::numeric, ${o.unit}, ${o.basis},
               ${input.captureId}, ${measurement?.id ?? null}, ${`capture:${input.captureId}:opening`}, ${owner.userId})`,
      );

      // The capture's photos are now evidence for what was saved.
      for (const target of ["container_id", "lot_id", "product_id"] as const) {
        const id = target === "container_id" ? containerId : target === "lot_id" ? lotId : productId;
        await tx.execute(
          sql`insert into inventory_document_links (organization_id, document_id, ${sql.raw(target)}, role)
              select l.organization_id, l.document_id, ${id}::uuid, 'label'
                from inventory_document_links l
               where l.capture_id = ${input.captureId}
              on conflict do nothing`,
        );
      }

      await recordReview(tx, owner, input);

      return { containerId, created: true };
    });
  } catch (err) {
    throw refusal(err) ?? err;
  }
}

async function existingProduct(tx: Transaction, productId: string): Promise<string> {
  const row = await one<{ id: string }>(tx, sql`select id from inventory_products where id = ${productId} and archived_at is null`);
  if (!row) throw new InventoryError("That product is not in this inventory.", "invalid", "product");
  return row.id;
}

async function newProduct(tx: Transaction, owner: InventoryOwner, input: ReviewInput, plan: OpeningPlan): Promise<string> {
  const brandId = input.brand ? await brandFor(tx, owner, input.brand) : null;
  const manufacturerId = input.manufacturer ? await manufacturerFor(tx, owner, input.manufacturer) : null;
  const product = await one<{ id: string }>(
    tx,
    sql`insert into inventory_products
          (organization_id, name, brand_id, manufacturer_id, form, composition, package_quantity, package_unit, gtin, created_by)
        values
          (${owner.organizationId}, ${input.productName!}, ${brandId}, ${manufacturerId}, ${input.form},
           ${input.single ? "single" : "unknown"}, ${plan.nominal?.quantity ?? null}::numeric, ${plan.nominal?.unit ?? null},
           ${input.gtin ?? null}, ${owner.userId})
        returning id`,
  );
  const productId = product!.id;

  // "It is all one ingredient": the whole contents is that material, gram for
  // gram (or ml for ml, item for item), which is what planning can count.
  if (input.single) {
    const materialId = await materialFor(tx, owner, input.materialName ?? input.productName!, plan.dimension);
    const base = BASE_UNIT[plan.dimension];
    await tx.execute(
      sql`insert into inventory_product_components
            (organization_id, product_id, material_id, quantity, unit, per_quantity, per_unit)
          values (${owner.organizationId}, ${productId}, ${materialId}, 1, ${base}, 1, ${base})`,
    );
  }
  return productId;
}

async function brandFor(tx: Transaction, owner: InventoryOwner, name: string): Promise<string> {
  const found = await one<{ id: string }>(tx, sql`select id from inventory_brands where lower(name) = lower(${name})`);
  if (found) return found.id;
  const made = await one<{ id: string }>(
    tx,
    sql`insert into inventory_brands (organization_id, name) values (${owner.organizationId}, ${name})
        on conflict (organization_id, lower(name)) do nothing
        returning id`,
  );
  return made?.id ?? (await one<{ id: string }>(tx, sql`select id from inventory_brands where lower(name) = lower(${name})`))!.id;
}

/**
 * The company that makes it: one this business already deals with by that
 * name, or a new listed company with its own 10XiD iD (list_company). Only
 * this business's own relationships are searched — a name is never matched
 * against another business's suppliers.
 */
async function manufacturerFor(tx: Transaction, owner: InventoryOwner, name: string): Promise<string> {
  const found = await one<{ id: string; is_manufacturer: boolean }>(
    tx,
    sql`select b.id, b.is_manufacturer
          from inventory_businesses b
          join organizations o on o.id = b.company_id
         where lower(o.name) = lower(${name})
         order by b.created_at
         limit 1`,
  );
  if (found) {
    if (!found.is_manufacturer) {
      await tx.execute(sql`update inventory_businesses set is_manufacturer = true, updated_at = now() where id = ${found.id}`);
    }
    return found.id;
  }
  const company = await one<{ company_id: string }>(tx, sql`select company_id from list_company(${name})`);
  const made = await one<{ id: string }>(
    tx,
    sql`insert into inventory_businesses (organization_id, company_id, is_manufacturer)
        values (${owner.organizationId}, ${company!.company_id}, true)
        returning id`,
  );
  return made!.id;
}

async function materialFor(tx: Transaction, owner: InventoryOwner, name: string, dimension: string): Promise<string> {
  const find = () =>
    one<{ id: string; dimension: string }>(
      tx,
      sql`select id, dimension from inventory_materials
           where lower(name) = lower(${name}) and specification is null and archived_at is null`,
    );
  const found = await find();
  if (found) {
    if (found.dimension !== dimension) {
      throw new InventoryError(
        `“${name}” is already a material measured by ${found.dimension}; this container is measured by ${dimension}.`,
        "invalid",
        "materialName",
      );
    }
    return found.id;
  }
  const made = await one<{ id: string }>(
    tx,
    sql`insert into inventory_materials (organization_id, name, dimension, created_by)
        values (${owner.organizationId}, ${name}, ${dimension}, ${owner.userId})
        on conflict (organization_id, lower(name), lower(coalesce(specification, ''))) where archived_at is null do nothing
        returning id`,
  );
  return made?.id ?? (await find())!.id;
}

/**
 * A lot is shared by containers with the same printed lot code (and date) of
 * the same product: two jars from one lot are one lot, two containers. With no
 * lot code, each container gets its own lot — nothing printed is no evidence
 * that two jars came from one batch.
 */
async function lotFor(tx: Transaction, owner: InventoryOwner, productId: string, input: ReviewInput): Promise<string> {
  if (input.lotCode) {
    const found = await one<{ id: string }>(
      tx,
      sql`select id from inventory_lots
           where product_id = ${productId} and lot_code = ${input.lotCode}
             and expiry_date is not distinct from ${input.expiryDate ?? null}::date
           order by created_at
           limit 1`,
    );
    if (found) return found.id;
  }
  const dated = input.expiryDate || input.expiryPrinted;
  const lot = await one<{ id: string }>(
    tx,
    sql`insert into inventory_lots
          (organization_id, product_id, lot_code, expiry_printed, expiry_kind, expiry_date, acquired_on)
        values
          (${owner.organizationId}, ${productId}, ${input.lotCode ?? null}, ${input.expiryPrinted ?? null},
           ${dated ? input.expiryKind : null}, ${input.expiryDate ?? null}::date, ${input.acquiredOn ?? null}::date)
        returning id`,
  );
  return lot!.id;
}

async function locationFor(tx: Transaction, owner: InventoryOwner, name: string): Promise<string> {
  const find = () =>
    one<{ id: string }>(tx, sql`select id from inventory_locations where lower(name) = lower(${name}) and archived_at is null`);
  const found = await find();
  if (found) return found.id;
  const made = await one<{ id: string }>(
    tx,
    sql`insert into inventory_locations (organization_id, name) values (${owner.organizationId}, ${name})
        on conflict (organization_id, lower(name)) where archived_at is null do nothing
        returning id`,
  );
  return made?.id ?? (await find())!.id;
}

/**
 * The person's decision on each value the reader found: kept as read
 * (accepted), changed (corrected, with what it became), or cleared
 * (rejected). The extraction is marked reviewed by them.
 */
async function recordReview(tx: Transaction, owner: InventoryOwner, input: ReviewInput): Promise<void> {
  const extraction = await one<{ id: string }>(
    tx,
    sql`select id from inventory_extractions
         where capture_id = ${input.captureId} and status = 'needs_review'
         order by created_at desc, id desc
         limit 1`,
  );
  if (!extraction) return;
  const fields = await all<{ id: string; field: string; value: unknown }>(
    tx,
    sql`select id, field, value from inventory_extracted_fields where extraction_id = ${extraction.id}`,
  );
  for (const f of fields) {
    const final = finalValue(f.field as ExtractedFieldName, input);
    const decision = final === undefined ? "rejected" : sameValue(f.field as ExtractedFieldName, f.value, final) ? "accepted" : "corrected";
    await tx.execute(
      sql`update inventory_extracted_fields
             set review = ${decision},
                 corrected_value = ${decision === "corrected" ? JSON.stringify(final) : null}::jsonb,
                 reviewed_at = now()
           where id = ${f.id}`,
    );
  }
  await tx.execute(
    sql`update inventory_extractions set status = 'reviewed', reviewed_by = ${owner.userId}, reviewed_at = now()
         where id = ${extraction.id}`,
  );
}

function finalValue(field: ExtractedFieldName, input: ReviewInput): unknown {
  switch (field) {
    case "product_name":
      return input.productName;
    case "brand":
      return input.brand;
    case "manufacturer":
      return input.manufacturer;
    case "lot_code":
      return input.lotCode;
    case "gtin":
      return input.gtin;
    case "form":
      return input.form === "unknown" ? undefined : input.form;
    case "net_quantity":
      return input.labelQuantity && input.labelUnit ? { amount: Number(input.labelQuantity), unit: input.labelUnit } : undefined;
    case "expiry":
      return input.expiryDate || input.expiryPrinted ? { date: input.expiryDate ?? null, kind: input.expiryKind } : undefined;
  }
}

function sameValue(field: ExtractedFieldName, read: unknown, final: unknown): boolean {
  if (field === "net_quantity") {
    const r = read as { amount?: unknown; unit?: unknown } | null;
    const f = final as { amount: number; unit: string };
    const unit = typeof r?.unit === "string" ? normalizeUnit(r.unit) : undefined;
    return Number(r?.amount) === f.amount && unit === f.unit;
  }
  if (field === "expiry") {
    const r = read as { date?: unknown; kind?: unknown } | null;
    const f = final as { date: string | null; kind: string };
    return (r?.date ?? null) === f.date && (r?.kind ?? "unknown") === f.kind;
  }
  return typeof read === "string" && typeof final === "string" && read.trim().toLowerCase() === final.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* The inventory                                                       */
/* ------------------------------------------------------------------ */

export type InventoryRow = {
  containerId: string;
  productName: string;
  brand: string | null;
  status: string;
  dimension: string;
  baseUnit: string;
  /** Null when not known. Never 0 for unknown. */
  balance: string | null;
  balanceBasis: string;
  nominalQuantity: string | null;
  nominalUnit: string | null;
  lotCode: string | null;
  expiryKind: string | null;
  expiryDate: string | null;
  hold: string;
  location: string | null;
  photoId: string | null;
  createdAt: Date;
};

/** Every container still on the shelf (sealed or open), by product. */
export async function listInventory(owner: InventoryOwner): Promise<InventoryRow[]> {
  const rows = await run(owner, (tx) =>
    all<{
      container_id: string;
      product_name: string;
      brand: string | null;
      status: string;
      dimension: string;
      base_unit: string;
      balance: string | null;
      balance_basis: string;
      nominal_quantity: string | null;
      nominal_unit: string | null;
      lot_code: string | null;
      expiry_kind: string | null;
      expiry_date: string | null;
      hold: string;
      location: string | null;
      photo_id: string | null;
      created_at: string;
    }>(
      tx,
      sql`select b.container_id, p.name as product_name, br.name as brand, b.status, b.dimension, b.base_unit,
                 b.balance::text, b.balance_basis, b.nominal_quantity::text, b.nominal_unit,
                 b.lot_code, b.expiry_kind, b.expiry_date::text, b.hold, loc.name as location,
                 (select l.document_id from inventory_document_links l
                   join inventory_documents d on d.organization_id = l.organization_id and d.id = l.document_id
                   where l.organization_id = b.organization_id and l.container_id = b.container_id and d.state = 'stored'
                   order by d.created_at, d.id limit 1) as photo_id,
                 c.created_at
            from inventory_container_balances b
            join inventory_containers c on c.organization_id = b.organization_id and c.id = b.container_id
            join inventory_products p on p.organization_id = b.organization_id and p.id = b.product_id
            left join inventory_brands br on br.organization_id = p.organization_id and br.id = p.brand_id
            left join inventory_locations loc on loc.organization_id = c.organization_id and loc.id = c.location_id
           where b.status in ('sealed', 'open')
           order by lower(p.name), c.created_at, c.id`,
    ),
  );
  return rows.map((r) => ({
    containerId: r.container_id,
    productName: r.product_name,
    brand: r.brand,
    status: r.status,
    dimension: r.dimension,
    baseUnit: r.base_unit,
    balance: r.balance,
    balanceBasis: r.balance_basis,
    nominalQuantity: r.nominal_quantity,
    nominalUnit: r.nominal_unit,
    lotCode: r.lot_code,
    expiryKind: r.expiry_kind,
    expiryDate: r.expiry_date,
    hold: r.hold,
    location: r.location,
    photoId: r.photo_id,
    createdAt: when(r.created_at),
  }));
}

/** For a unit code from the database, the label the screens use. */
export function unitLabel(code: string | null): string {
  if (!code) return "";
  return code in UNITS ? UNITS[code as keyof typeof UNITS].label : code;
}
