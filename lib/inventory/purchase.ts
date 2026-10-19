import { z } from "zod";
import { isCalendarDate } from "./review";

/**
 * How a container was bought, as the purchase form sends it: who sold it,
 * when, what this package cost and in which currency, and which paperwork
 * shows it. Every field may be left empty — not known, never a guess — and
 * the database keeps each saved version (login 0049).
 *
 * Plain functions, no server imports: the actions and the tests share them.
 */

/** The currencies the form offers first; any ISO 4217 code of three capitals is taken. */
export const CURRENCIES = ["CAD", "USD", "EUR", "GBP"] as const;

/** What the form sends: text as typed. */
export const PURCHASE_FIELDS = ["containerId", "version", "requestKey", "vendor", "acquiredOn", "price", "currency", "documentId", "today"] as const;
export type PurchaseField = (typeof PURCHASE_FIELDS)[number];

/** A price as people type it: up to 10 digits, then at most two decimals after a point or a comma. Never NaN, never negative. */
const PRICE = /^\d{1,10}([.,]\d{1,2})?$/;

const optional = (schema: z.ZodType<string>) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.union([z.literal("").transform(() => null), schema]));

/** One company name as list_company() keeps it: spaces collapsed, 1 to 200 characters. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Ids compared as the database prints them. */
const id = () => z.uuid().transform((s) => s.toLowerCase());

export const purchaseSchema = z
  .object({
    containerId: id(),
    /** The current record the page showed, or "-" when there was none. */
    version: z.union([z.literal("-"), id()]),
    requestKey: id(),
    vendor: optional(z.string().transform(cleanName).pipe(z.string().min(1).max(200))),
    acquiredOn: optional(z.string().refine(isCalendarDate)),
    price: optional(z.string().regex(PRICE).transform((p) => normalizePrice(p))),
    currency: optional(z.string().regex(/^[A-Z]{3}$/)),
    documentId: optional(id()),
    /** The phone's own date, so "today" is the person's today; anything else is ignored. */
    today: z.preprocess((v) => (typeof v === "string" && isCalendarDate(v.trim()) ? v.trim() : null), z.string().nullable()),
  })
  .superRefine((v, ctx) => {
    if (v.price !== null && v.currency === null) ctx.addIssue({ code: "custom", path: ["currency"], message: "currency" });
  });

export type PurchaseInput = z.infer<typeof purchaseSchema>;

/** "18,5" → "18.50", "007" → "7.00": the price as the database prints numeric(12,2). */
export function normalizePrice(typed: string): string {
  const [whole, fraction = ""] = typed.replace(",", ".").split(".");
  return `${String(Number(whole))}.${fraction.padEnd(2, "0")}`;
}

/**
 * A day of purchase cannot be after today. "Today" is the later of the
 * phone's date and the server's, so a phone a time zone ahead is believed,
 * and one with a wrong clock cannot move it further.
 */
export function inTheFuture(day: string, phoneToday: string | null, now = new Date()): boolean {
  const serverToday = now.toISOString().slice(0, 10);
  const plusOne = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const phone = phoneToday && phoneToday <= plusOne ? phoneToday : serverToday;
  const latest = phone > serverToday ? phone : serverToday;
  return day > latest;
}

/** What the preferred-seller form sends. */
export const PREFERRED_FIELDS = ["containerId", "version", "vendor"] as const;
export type PreferredField = (typeof PREFERRED_FIELDS)[number];

export const preferredSchema = z.object({
  containerId: id(),
  /** The preferred seller the page showed: its row and when it last changed, or "-" for none. */
  version: z.union([z.literal("-"), z.string().regex(/^p1\.[0-9a-f-]{36}\.\d{1,20}$/)]),
  vendor: optional(z.string().transform(cleanName).pipe(z.string().min(1).max(200))),
});

export type PreferredInput = z.infer<typeof preferredSchema>;

/* ------------------------------------------------------------------ */
/* Paperwork                                                           */
/* ------------------------------------------------------------------ */

/** The largest invoice or receipt one upload takes (the portal refuses requests over 10MB). */
export const MAX_PAPERWORK_BYTES = 9 * 1024 * 1024;

/** A PDF starts with "%PDF-". Only its first bytes are trusted, never the name or the browser's word. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/** "Receipt (2).PDF" → "Receipt (2).PDF"; anything that is not plain printable text is dropped, at most 200 characters. */
export function paperworkName(name: string | null | undefined): string | null {
  if (!name) return null;
  const clean = name.replace(/[^\p{L}\p{N} ._()\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return clean || null;
}
