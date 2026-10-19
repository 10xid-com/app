import { z } from "zod";
import { UNITS, UNIT_CODES, isCalendarDate, parseDecimal, type Dimension, type UnitCode } from "./review";

/**
 * Looking after a container once it is catalogued: what is in it now, opening
 * it, where it is.
 *
 * Pure: no database, no request. The container page's server actions parse
 * their forms here, and `planCount` decides what one later amount is — always
 * a NEW count, appended to the ledger; the opening and every earlier event
 * stay exactly as they were, true when they were recorded. It is said one of
 * two honest ways:
 *
 *   estimated   "About…", in a unit of the container's own kind (grams, ml or
 *               items); or a weighing whose empty-container weight was itself
 *               an estimate
 *   measured    weighed on a scale with the empty container weighed too
 *               (login's 0048 checks it again: scale, exact, grams, the net)
 *
 * A later amount is never "I don't know": an amount nobody knows stays as it
 * was recorded, and a known one changes only with an estimate or a weighing.
 * Nothing here turns a gross weight into contents, or zero into unknown.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^\d{1,9}(\.\d{1,3})?$/;

/**
 * What the page last saw of a container: its row's last change, to the
 * microsecond, and its ledger — how many events and the latest one, reversals
 * included. Any write in between changes it (lib/db/inventory.ts versionOf).
 */
export const VERSION = /^v1\.\d{1,20}\.\d{1,9}\.([0-9a-f-]{36}|-)$/;

const uuid = z.string().regex(UUID);

const decimal = z
  .string()
  .transform(parseDecimal)
  .refine((v) => v === undefined || DECIMAL.test(v), "a number, like 250 or 12.5");

const unit = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || (UNIT_CODES as string[]).includes(v), "a unit")
  .transform((v) => v as UnitCode | undefined);

/** One line of text: trimmed, inner whitespace collapsed, empty is nothing. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v.replace(/\s+/g, " ")));

/** A few lines: trimmed, line breaks kept (as \n), empty is nothing. */
const lines = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\r\n?/g, "\n").trim())
    .refine((v) => v.length <= max, `at most ${max} characters`)
    .transform((v) => (v === "" ? null : v));

/** The amount form (and the open form, which may carry one). Every value arrives as a string. */
export const amountSchema = z.object({
  containerId: uuid,
  version: z.string().regex(VERSION),
  /** Made when the page was drawn: the same request sent twice is answered once. */
  requestKey: uuid,
  intent: z.enum(["amount", "open"]),
  /** "" when opening without saying how much is in it. */
  amount: z
    .string()
    .trim()
    .transform((v) => (v === "estimate" || v === "weighed" ? v : undefined)),
  estimateQuantity: decimal,
  estimateUnit: unit,
  grossG: decimal,
  tareG: decimal,
  tareBasis: z
    .string()
    .trim()
    .transform((v) => (v === "measured" || v === "estimated" ? v : undefined)),
  /** The phone's own date, for the day it was opened (checked against the server's). */
  today: z
    .string()
    .trim()
    .transform((v) => (isCalendarDate(v) ? v : undefined)),
});

export type AmountInput = z.output<typeof amountSchema>;

export const AMOUNT_FIELDS = [
  "containerId",
  "version",
  "requestKey",
  "intent",
  "amount",
  "estimateQuantity",
  "estimateUnit",
  "grossG",
  "tareG",
  "tareBasis",
  "today",
] as const;

export type AmountField = (typeof AMOUNT_FIELDS)[number];

/** Where it is and what to remember about it. */
export const detailsSchema = z.object({
  containerId: uuid,
  version: z.string().regex(VERSION),
  location: line(100),
  notes: lines(2000),
});

export type DetailsInput = z.output<typeof detailsSchema>;

export const DETAILS_FIELDS = ["containerId", "version", "location", "notes"] as const;

export type DetailsField = (typeof DETAILS_FIELDS)[number];

/** FormData → plain strings for the named fields; anything absent is "". */
export function fieldsOf<F extends string>(formData: FormData, names: readonly F[]): Record<F, string> {
  const out = {} as Record<F, string>;
  for (const name of names) {
    const v = formData.get(name);
    out[name] = typeof v === "string" ? v : "";
  }
  return out;
}

export type CountPlan = {
  /** A weighing, in grams; its net (gross − empty) is left to the database. */
  measurement: { grossG: string; tareG: string; tareBasis: "measured" | "estimated"; confidence: "exact" | "estimated" } | null;
  count:
    | { basis: "estimated"; quantity: string; unit: UnitCode }
    /** The amount is the weighing's net, read back from the database. */
    | { basis: "measured" | "estimated"; quantity: "net"; unit: "g" };
};

export type CountResult = { ok: true; plan: CountPlan } | { ok: false; field: AmountField; error: string };

const no = (field: AmountField, error: string): CountResult => ({ ok: false, field, error });

/** One later amount for a container measured by `dimension`. */
export function planCount(input: AmountInput, dimension: Dimension): CountResult {
  switch (input.amount) {
    case "estimate": {
      if (input.estimateQuantity === undefined) return no("estimateQuantity", "About how much is in it?");
      if (!input.estimateUnit) return no("estimateUnit", "In which unit?");
      if (UNITS[input.estimateUnit].dimension !== dimension) {
        return no("estimateUnit", `This container is measured in ${kindOf(dimension)}; estimate in the same kind of unit.`);
      }
      return { ok: true, plan: { measurement: null, count: { basis: "estimated", quantity: input.estimateQuantity, unit: input.estimateUnit } } };
    }
    case "weighed": {
      if (dimension !== "mass") return no("amount", `A scale weighs grams, and this container is measured in ${kindOf(dimension)}. Estimate it instead.`);
      if (input.grossG === undefined || Number(input.grossG) <= 0) return no("grossG", "What did the scale say, in grams?");
      // Without the empty container's weight the scale says nothing about
      // what is inside, so there is no amount to record.
      if (input.tareG === undefined) return no("tareG", "What does the empty container weigh? Without it, estimate the amount instead.");
      if (Number(input.tareG) > Number(input.grossG)) return no("tareG", "The empty container cannot weigh more than the full one.");
      if (!input.tareBasis) return no("tareBasis", "Was the empty container weighed, or is its weight an estimate?");
      const measured = input.tareBasis === "measured";
      return {
        ok: true,
        plan: {
          measurement: { grossG: input.grossG, tareG: input.tareG, tareBasis: input.tareBasis, confidence: measured ? "exact" : "estimated" },
          count: { basis: measured ? "measured" : "estimated", quantity: "net", unit: "g" },
        },
      };
    }
    default:
      return no("amount", "Choose how you know the amount: about how much, or weighed.");
  }
}

export function kindOf(dimension: Dimension): string {
  return dimension === "mass" ? "grams" : dimension === "volume" ? "millilitres" : "items";
}

/** The units an amount for a container of this kind may be given in, for the form. */
export function unitsFor(dimension: Dimension): UnitCode[] {
  return UNIT_CODES.filter((u) => UNITS[u].dimension === dimension);
}

/**
 * The day it was opened: the phone's date when it is within a day of the
 * server's (time zones), otherwise the server's.
 */
export function openedOn(phoneDate: string | undefined, now = new Date()): string {
  const server = now.toISOString().slice(0, 10);
  if (!phoneDate) return server;
  const days = Math.abs(Date.parse(`${phoneDate}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`)) / 86_400_000;
  return days <= 1 ? phoneDate : server;
}
