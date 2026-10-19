import { z } from "zod";

/**
 * Turning the review form into what is recorded.
 *
 * Pure: no database, no request. The capture's server action parses the form
 * with `reviewSchema`, then `planOpening` decides the container's dimension,
 * the label's nominal amount, the optional weighing, and the ONE opening event
 * — with a basis the database will accept and that says only what is known:
 *
 *   labelled_unopened   a sealed package, at exactly what its label says
 *                       (chosen, or `auto` when the label states one)
 *   measured            weighed on a scale, with the empty container's weight
 *                       weighed too (login's 0048: scale, exact, mass, net)
 *   estimated           an estimate, or a weighing whose tare was estimated
 *   unknown             nothing known yet — still catalogued, never zero
 *
 * Nothing here turns a gross weight, an opened package's label or a guess into
 * a measured amount.
 */

export const UNITS = {
  g: { dimension: "mass", toBase: 1, label: "g" },
  kg: { dimension: "mass", toBase: 1000, label: "kg" },
  mg: { dimension: "mass", toBase: 0.001, label: "mg" },
  oz: { dimension: "mass", toBase: 28.349523125, label: "oz" },
  lb: { dimension: "mass", toBase: 453.59237, label: "lb" },
  ml: { dimension: "volume", toBase: 1, label: "ml" },
  l: { dimension: "volume", toBase: 1000, label: "L" },
  fl_oz: { dimension: "volume", toBase: 29.5735295625, label: "fl oz" },
  count: { dimension: "count", toBase: 1, label: "items" },
} as const;

export type UnitCode = keyof typeof UNITS;
export type Dimension = (typeof UNITS)[UnitCode]["dimension"];
export const UNIT_CODES = Object.keys(UNITS) as UnitCode[];

export const BASE_UNIT: Record<Dimension, UnitCode> = { mass: "g", volume: "ml", count: "count" };

export const PRODUCT_FORMS = [
  "powder",
  "extract_powder",
  "juice_powder",
  "whole",
  "cut",
  "granules",
  "crystals",
  "liquid",
  "capsules",
  "tablets",
  "other",
  "unknown",
] as const;
export type ProductForm = (typeof PRODUCT_FORMS)[number];

export const EXPIRY_KINDS = ["best_before", "expiry", "use_by", "unknown"] as const;
export type ExpiryKind = (typeof EXPIRY_KINDS)[number];

/**
 * How the amount is known. `auto` is the quick screen's sealed package: its
 * label amount when the label states a valid one, otherwise unknown — never a
 * guess, never zero.
 */
export const AMOUNT_CHOICES = ["label", "weighed", "estimate", "unknown", "auto"] as const;
export type AmountChoice = (typeof AMOUNT_CHOICES)[number];

/** "1,5" from a French keyboard is 1.5; at most 9 digits before the point and 3 after. */
const DECIMAL = /^\d{1,9}(\.\d{1,3})?$/;

export function parseDecimal(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().replace(",", ".");
  return v === "" ? undefined : v;
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? undefined : v.replace(/\s+/g, " ")));

const decimal = z
  .string()
  .transform(parseDecimal)
  .refine((v) => v === undefined || DECIMAL.test(v), "a number, like 500 or 12.5");

/** YYYY-MM-DD naming a day that exists: Date.parse alone accepts 2026-02-30 and rolls it over. */
export function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

const isoDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || isCalendarDate(v), "a date");

const unit = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || (UNIT_CODES as string[]).includes(v), "a unit")
  .transform((v) => v as UnitCode | undefined);

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The review form, as the server action receives it (every value a string). */
export const reviewSchema = z
  .object({
    captureId: uuid,
    /** "new", or the id of a product already catalogued. */
    product: z.union([z.literal("new"), uuid]),
    productName: text(200),
    brand: text(200),
    manufacturer: text(200),
    form: z.enum(PRODUCT_FORMS).catch("unknown"),
    gtin: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s-]/g, ""))
      .refine((v) => v === "" || /^[0-9]{8,14}$/.test(v), "8 to 14 digits")
      .transform((v) => (v === "" ? undefined : v)),
    /** The checkbox: present ("on") when ticked. */
    single: z
      .string()
      .optional()
      .transform((v) => v === "on"),
    materialName: text(200),
    labelQuantity: decimal,
    labelUnit: unit,
    lotCode: text(100),
    expiryPrinted: text(100),
    expiryDate: isoDate,
    expiryKind: z.enum(EXPIRY_KINDS).catch("unknown"),
    status: z.enum(["sealed", "open"]),
    amount: z.enum(AMOUNT_CHOICES),
    grossG: decimal,
    tareG: decimal,
    // Said, never assumed: whether the empty weight was weighed decides
    // whether the amount is a weighed one (planOpening asks when it matters).
    tareBasis: z
      .string()
      .trim()
      .transform((v) => (v === "measured" || v === "estimated" ? v : undefined)),
    estimateQuantity: decimal,
    estimateUnit: unit,
    location: text(100),
    acquiredOn: isoDate,
    notes: text(2000),
  })
  .superRefine((v, ctx) => {
    if (v.product === "new" && !v.productName) {
      ctx.addIssue({ code: "custom", path: ["productName"], message: "What is it called?" });
    }
  });

export type ReviewInput = z.output<typeof reviewSchema>;

/** The form's fields by name, for reading FormData into the schema. */
export const REVIEW_FIELDS = [
  "captureId",
  "product",
  "productName",
  "brand",
  "manufacturer",
  "form",
  "gtin",
  "single",
  "materialName",
  "labelQuantity",
  "labelUnit",
  "lotCode",
  "expiryPrinted",
  "expiryDate",
  "expiryKind",
  "status",
  "amount",
  "grossG",
  "tareG",
  "tareBasis",
  "estimateQuantity",
  "estimateUnit",
  "location",
  "acquiredOn",
  "notes",
] as const;

export type ReviewField = (typeof REVIEW_FIELDS)[number];

/** FormData → plain strings, absent fields left out (a checkbox is absent when unticked). */
export function formValues(formData: FormData): Partial<Record<ReviewField, string>> {
  const out: Partial<Record<ReviewField, string>> = {};
  for (const name of REVIEW_FIELDS) {
    const v = formData.get(name);
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

export type OpeningPlan = {
  dimension: Dimension;
  nominal: { quantity: string; unit: UnitCode } | null;
  /** The weighing, in grams, when there was one. Net is left to the database: gross − tare. */
  measurement: {
    grossG: string;
    tareG: string | null;
    tareBasis: "measured" | "estimated" | null;
    confidence: "exact" | "estimated";
  } | null;
  opening:
    | { basis: "labelled_unopened" | "estimated"; quantity: string; unit: UnitCode }
    /** The amount is the weighing's net, read back from the database. */
    | { basis: "measured" | "estimated"; quantity: "net"; unit: "g" }
    | { basis: "unknown"; quantity: null; unit: null };
};

export type PlanResult = { ok: true; plan: OpeningPlan } | { ok: false; field: ReviewField; error: string };

const no = (field: ReviewField, error: string): PlanResult => ({ ok: false, field, error });

export function planOpening(input: ReviewInput): PlanResult {
  // What the container is measured by: the label's unit, else the estimate's,
  // else mass (a scale weighs grams).
  const labelDim = input.labelUnit ? UNITS[input.labelUnit].dimension : undefined;
  const estimateDim = input.estimateUnit ? UNITS[input.estimateUnit].dimension : undefined;
  if (input.labelQuantity !== undefined && !input.labelUnit) return no("labelUnit", "Which unit is the label in?");
  if (input.labelUnit && input.labelQuantity === undefined) return no("labelQuantity", "How much does the label say?");
  if (input.labelQuantity !== undefined && Number(input.labelQuantity) <= 0) {
    return no("labelQuantity", "The label amount has to be more than zero.");
  }
  const dimension: Dimension = labelDim ?? (input.amount === "estimate" ? estimateDim : undefined) ?? "mass";
  const nominal = input.labelQuantity !== undefined && input.labelUnit ? { quantity: input.labelQuantity, unit: input.labelUnit } : null;

  switch (input.amount) {
    case "auto": {
      // The quick screen: a sealed package is what its label says when the
      // label says something valid; otherwise its amount is not known yet.
      if (input.status !== "sealed") return no("amount", "How much is in it? Weigh it, estimate it, or choose “I don’t know yet”.");
      if (nominal) return { ok: true, plan: { dimension, nominal, measurement: null, opening: { basis: "labelled_unopened", ...nominal } } };
      return { ok: true, plan: { dimension, nominal, measurement: null, opening: { basis: "unknown", quantity: null, unit: null } } };
    }
    case "label": {
      if (!nominal) return no("labelQuantity", "Say what the label says it holds, or choose another way to record the amount.");
      if (input.status !== "sealed") {
        return no("amount", "An opened package is not still its label weight. Weigh it, estimate it, or choose “I don’t know”.");
      }
      return { ok: true, plan: { dimension, nominal, measurement: null, opening: { basis: "labelled_unopened", ...nominal } } };
    }

    case "weighed": {
      if (dimension !== "mass") {
        return no("amount", `A scale weighs grams, and this container is measured by ${dimension}. Estimate it instead.`);
      }
      if (input.grossG === undefined || Number(input.grossG) <= 0) return no("grossG", "What did the scale say, in grams?");
      if (input.tareG === undefined) {
        // Without the empty container's weight the gross says nothing about
        // what is inside: keep the weighing as evidence, the amount unknown.
        return {
          ok: true,
          plan: {
            dimension,
            nominal,
            measurement: { grossG: input.grossG, tareG: null, tareBasis: null, confidence: "exact" },
            opening: { basis: "unknown", quantity: null, unit: null },
          },
        };
      }
      const net = Number(input.grossG) - Number(input.tareG);
      if (net < 0) return no("tareG", "The empty container cannot weigh more than the full one.");
      if (net === 0) return no("tareG", "That leaves nothing inside. An empty container is not catalogued.");
      if (!input.tareBasis) return no("tareBasis", "Was the empty container weighed, or is its weight an estimate?");
      const measured = input.tareBasis === "measured";
      return {
        ok: true,
        plan: {
          dimension,
          nominal,
          measurement: {
            grossG: input.grossG,
            tareG: input.tareG,
            tareBasis: measured ? "measured" : "estimated",
            confidence: measured ? "exact" : "estimated",
          },
          opening: { basis: measured ? "measured" : "estimated", quantity: "net", unit: "g" },
        },
      };
    }

    case "estimate": {
      if (input.estimateQuantity === undefined || Number(input.estimateQuantity) <= 0) {
        return no("estimateQuantity", "About how much is in it?");
      }
      if (!input.estimateUnit) return no("estimateUnit", "In which unit?");
      if (UNITS[input.estimateUnit].dimension !== dimension) {
        return no("estimateUnit", `The label is in ${dimension === "count" ? "items" : dimension}; estimate in the same kind of unit.`);
      }
      return {
        ok: true,
        plan: {
          dimension,
          nominal,
          measurement: null,
          opening: { basis: "estimated", quantity: input.estimateQuantity, unit: input.estimateUnit },
        },
      };
    }

    case "unknown":
      return { ok: true, plan: { dimension, nominal, measurement: null, opening: { basis: "unknown", quantity: null, unit: null } } };
  }
}

/* ------------------------------------------------------------------ */
/* What the label reader found, as the form's starting values          */
/* ------------------------------------------------------------------ */

/** The fields an extraction stores (inventory_extracted_fields.field). */
export const EXTRACTED_FIELDS = [
  "product_name",
  "brand",
  "manufacturer",
  "net_quantity",
  "lot_code",
  "expiry",
  "gtin",
  "form",
] as const;
export type ExtractedFieldName = (typeof EXTRACTED_FIELDS)[number];

export type ExtractedValues = {
  productName?: string;
  brand?: string;
  manufacturer?: string;
  netQuantity?: { amount: string; unit: UnitCode };
  lotCode?: string;
  expiry?: { date: string | null; kind: ExpiryKind; printed: string | null };
  gtin?: string;
  form?: ProductForm;
};

/** A stored field row → the form value it suggests. Anything malformed is ignored. */
export function suggestionsFrom(fields: { field: string; value: unknown; rawText: string | null }[]): ExtractedValues {
  const out: ExtractedValues = {};
  for (const f of fields) {
    const v = f.value;
    switch (f.field) {
      case "product_name":
      case "brand":
      case "manufacturer":
      case "lot_code": {
        if (typeof v !== "string" || !v.trim()) break;
        const key = ({ product_name: "productName", brand: "brand", manufacturer: "manufacturer", lot_code: "lotCode" } as const)[f.field];
        out[key] = v.trim().slice(0, key === "lotCode" ? 100 : 200);
        break;
      }
      case "gtin":
        if (typeof v === "string" && /^[0-9]{8,14}$/.test(v)) out.gtin = v;
        break;
      case "form":
        if (typeof v === "string" && (PRODUCT_FORMS as readonly string[]).includes(v)) out.form = v as ProductForm;
        break;
      case "net_quantity": {
        const q = v as { amount?: unknown; unit?: unknown } | null;
        const amount = typeof q?.amount === "number" ? String(q.amount) : typeof q?.amount === "string" ? q.amount : undefined;
        const unitCode = typeof q?.unit === "string" ? normalizeUnit(q.unit) : undefined;
        if (amount && DECIMAL.test(amount) && Number(amount) > 0 && unitCode) out.netQuantity = { amount, unit: unitCode };
        break;
      }
      case "expiry": {
        const e = v as { date?: unknown; kind?: unknown } | null;
        // A day that exists: 2026-02-30 would vanish from a date field without a word.
        const date = typeof e?.date === "string" && isCalendarDate(e.date) ? e.date : null;
        const kind = typeof e?.kind === "string" && (EXPIRY_KINDS as readonly string[]).includes(e.kind) ? (e.kind as ExpiryKind) : "unknown";
        if (date || f.rawText) out.expiry = { date, kind, printed: f.rawText?.slice(0, 100) ?? null };
        break;
      }
    }
  }
  return out;
}

/**
 * What the reader found that cannot go into the form as it is — an amount
 * that is not a number, a unit stock is not kept in, a barcode that is not
 * one, a day that does not exist — with what it read, so the screen can show
 * it beside the field to correct or leave empty instead of dropping it
 * without a word.
 */
export function unusableReadings(
  fields: { field: string; value: unknown; rawText: string | null }[],
): { field: ReviewField; read: string }[] {
  const out: { field: ReviewField; read: string }[] = [];
  const shown = (raw: string | null, fallback: string) => (raw?.trim() || fallback).slice(0, 120);
  for (const f of fields) {
    const v = f.value;
    if (v === null || v === undefined || v === "") continue;
    switch (f.field) {
      case "net_quantity": {
        const q = v as { amount?: unknown; unit?: unknown };
        const amount = typeof q?.amount === "number" ? String(q.amount) : typeof q?.amount === "string" ? q.amount : undefined;
        const unitCode = typeof q?.unit === "string" ? normalizeUnit(q.unit) : undefined;
        if (!(amount && DECIMAL.test(amount) && Number(amount) > 0 && unitCode)) {
          out.push({ field: "labelQuantity", read: shown(f.rawText, `${String(q?.amount ?? "")} ${String(q?.unit ?? "")}`.trim()) });
        }
        break;
      }
      case "gtin":
        if (!(typeof v === "string" && /^[0-9]{8,14}$/.test(v))) out.push({ field: "gtin", read: shown(f.rawText, String(v)) });
        break;
      case "form":
        if (!(typeof v === "string" && (PRODUCT_FORMS as readonly string[]).includes(v))) out.push({ field: "form", read: shown(f.rawText, String(v)) });
        break;
      case "expiry": {
        const e = v as { date?: unknown };
        if (typeof e?.date === "string" && e.date && !isCalendarDate(e.date)) out.push({ field: "expiryDate", read: shown(null, e.date) });
        break;
      }
    }
  }
  return out;
}

/** "G", "grams", "Fl. Oz" → a unit code, or undefined when it is not one we record stock in. */
export function normalizeUnit(raw: string): UnitCode | undefined {
  const u = raw.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  const table: Record<string, UnitCode> = {
    g: "g", gr: "g", gram: "g", grams: "g", gramme: "g", grammes: "g",
    kg: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
    mg: "mg", milligram: "mg", milligrams: "mg",
    oz: "oz", ounce: "oz", ounces: "oz", "net wt oz": "oz",
    lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
    ml: "ml", millilitre: "ml", milliliter: "ml", millilitres: "ml", milliliters: "ml",
    l: "l", litre: "l", liter: "l", litres: "l", liters: "l",
    "fl oz": "fl_oz", "fl_oz": "fl_oz", floz: "fl_oz", "fluid ounce": "fl_oz", "fluid ounces": "fl_oz",
    count: "count", each: "count", ct: "count", capsules: "count", tablets: "count", items: "count", pieces: "count",
  };
  return table[u];
}

/** How a balance reads on screen: never "0" for unknown. */
export function describeBalance(balance: string | null, basis: string, baseUnit: string): string {
  if (balance === null || basis === "unknown") return "Unknown";
  const n = Number(balance);
  const shown = Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1).replace(/\.?0+$/, "");
  const unitLabel = baseUnit === "count" ? (n === 1 ? "item" : "items") : baseUnit;
  return `${shown} ${unitLabel}`;
}

export const BASIS_LABELS: Record<string, string> = {
  labelled_unopened: "as labelled, sealed",
  measured: "weighed",
  estimated: "estimate",
  calculated: "calculated",
  unknown: "not known yet",
};
