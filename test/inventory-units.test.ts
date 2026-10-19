import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_PHOTO_BYTES, sniffPhoto, modelCanRead } from "@/lib/inventory/files";
import { describeBalance, normalizeUnit, planOpening, reviewSchema, suggestionsFrom, REVIEW_FIELDS, type ReviewInput } from "@/lib/inventory/review";
import { fieldsFromReading } from "@/lib/inventory/extract";

/**
 * The parts of inventory capture that need no database: what a photo is,
 * how a reviewed form becomes one opening event, what a label reader's answer
 * may become, and that nothing can delete an inventory photo from the store.
 */

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("a photo is judged by its bytes", () => {
  test("JPEG, PNG, WebP, HEIC and HEIF are kept, with the key extension 0048 allows", () => {
    expect(sniffPhoto(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ contentType: "image/jpeg", extension: "jpg" });
    expect(sniffPhoto(bytes(0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ contentType: "image/png", extension: "png" });
    expect(sniffPhoto(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")))).toEqual({ contentType: "image/webp", extension: "webp" });
    expect(sniffPhoto(bytes(0, 0, 0, 24, ...ascii("ftypheic")))).toEqual({ contentType: "image/heic", extension: "heic" });
    expect(sniffPhoto(bytes(0, 0, 0, 24, ...ascii("ftypmif1")))).toEqual({ contentType: "image/heif", extension: "heic" });
  });

  test("anything else is refused, whatever it was called", () => {
    expect(sniffPhoto(bytes(...ascii("%PDF-1.7")))).toBeNull();
    expect(sniffPhoto(bytes(0, 0, 0, 24, ...ascii("ftypavif")))).toBeNull();
    expect(sniffPhoto(bytes(...ascii("<svg xmlns")))).toBeNull();
    expect(sniffPhoto(bytes())).toBeNull();
  });

  test("the reader is shown JPEG, PNG and WebP; HEIC is kept but not sent", () => {
    expect(modelCanRead("image/jpeg")).toBe(true);
    expect(modelCanRead("image/heic")).toBe(false);
    expect(MAX_PHOTO_BYTES).toBeLessThan(10 * 1024 * 1024);
  });
});

/** A reviewed form, as the action would parse it. */
function form(values: Partial<Record<(typeof REVIEW_FIELDS)[number], string>>): ReviewInput {
  const base = Object.fromEntries(REVIEW_FIELDS.map((f) => [f, ""]));
  return reviewSchema.parse({
    ...base,
    captureId: "00000000-0000-4000-8000-000000000001",
    product: "new",
    productName: "Cacao powder",
    status: "sealed",
    amount: "unknown",
    ...values,
  });
}

describe("the opening event says only what is known", () => {
  test("a sealed package at its label is labelled_unopened, at exactly the label's figure", () => {
    const r = planOpening(form({ labelQuantity: "500", labelUnit: "g", amount: "label" }));
    expect(r).toEqual({
      ok: true,
      plan: {
        dimension: "mass",
        nominal: { quantity: "500", unit: "g" },
        measurement: null,
        opening: { basis: "labelled_unopened", quantity: "500", unit: "g" },
      },
    });
  });

  test("an opened package is never its label weight", () => {
    const r = planOpening(form({ labelQuantity: "500", labelUnit: "g", amount: "label", status: "open" }));
    expect(r.ok).toBe(false);
  });

  test("weighed with a weighed empty container is measured, from the net", () => {
    const r = planOpening(form({ amount: "weighed", grossG: "330", tareG: "30", tareBasis: "measured", status: "open" }));
    expect(r.ok && r.plan.opening).toEqual({ basis: "measured", quantity: "net", unit: "g" });
    expect(r.ok && r.plan.measurement).toEqual({ grossG: "330", tareG: "30", tareBasis: "measured", confidence: "exact" });
  });

  test("an estimated empty weight makes it an estimate, never measured", () => {
    const r = planOpening(form({ amount: "weighed", grossG: "330", tareG: "30", tareBasis: "estimated", status: "open" }));
    expect(r.ok && r.plan.opening.basis).toBe("estimated");
    expect(r.ok && r.plan.measurement?.confidence).toBe("estimated");
  });

  test("an empty weight nobody said how they got is asked about, not assumed", () => {
    const r = planOpening(form({ amount: "weighed", grossG: "330", tareG: "30", status: "open" }));
    expect(r).toMatchObject({ ok: false, field: "tareBasis" });
  });

  test("a gross weight alone is evidence, and the amount stays unknown", () => {
    const r = planOpening(form({ amount: "weighed", grossG: "330", status: "open" }));
    expect(r.ok && r.plan.opening).toEqual({ basis: "unknown", quantity: null, unit: null });
    expect(r.ok && r.plan.measurement).toEqual({ grossG: "330", tareG: null, tareBasis: null, confidence: "exact" });
  });

  test("a scale cannot weigh a container measured in millilitres or items", () => {
    expect(planOpening(form({ labelQuantity: "500", labelUnit: "ml", amount: "weighed", grossG: "600", tareG: "80", tareBasis: "measured" })).ok).toBe(false);
    expect(planOpening(form({ labelQuantity: "60", labelUnit: "count", amount: "weighed", grossG: "90" })).ok).toBe(false);
  });

  test("an estimate is in the container's own kind of unit", () => {
    expect(planOpening(form({ labelQuantity: "500", labelUnit: "g", amount: "estimate", estimateQuantity: "250", estimateUnit: "g" })).ok).toBe(true);
    expect(planOpening(form({ labelQuantity: "500", labelUnit: "g", amount: "estimate", estimateQuantity: "250", estimateUnit: "ml" })).ok).toBe(false);
  });

  test("nothing known is still catalogued, as unknown", () => {
    const r = planOpening(form({}));
    expect(r.ok && r.plan).toEqual({ dimension: "mass", nominal: null, measurement: null, opening: { basis: "unknown", quantity: null, unit: null } });
  });

  test("a comma decimal from a French keyboard is a decimal", () => {
    expect(form({ labelQuantity: "12,5", labelUnit: "g" }).labelQuantity).toBe("12.5");
  });

  test("an unknown amount reads Unknown, never 0", () => {
    expect(describeBalance(null, "unknown", "g")).toBe("Unknown");
    expect(describeBalance("0.0000", "unknown", "g")).toBe("Unknown");
    expect(describeBalance("300.0000", "measured", "g")).toBe("300 g");
  });
});

describe("what the label reader may say", () => {
  const ids = ["doc-1", "doc-2"];

  test("fields that fit are kept, with the photo they were read from", () => {
    const rows = fieldsFromReading(
      {
        product_name: { value: "Raw Cacao Powder", printed: "RAW CACAO POWDER", confidence: 0.94, photo: 1 },
        brand: { value: null, printed: null, confidence: 0.1, photo: null },
        manufacturer: { value: "Example Foods Ltd.", printed: "Manufactured by Example Foods Ltd.", confidence: 0.8, photo: 2 },
        net_quantity: { amount: 454, unit: "g", printed: "Net Wt 1 lb (454 g)", confidence: 0.9, photo: 1 },
        lot_code: { value: "L2417A", printed: "LOT L2417A", confidence: 0.7, photo: 2 },
        expiry: { date: "2027-03-01", kind: "best_before", printed: "BB 2027 MR 01", confidence: 0.6, photo: 2 },
        gtin: { value: "0 12345 67890 5", printed: "0 12345 67890 5", confidence: 0.85, photo: 2 },
        form: { value: "powder", printed: null, confidence: 0.9, photo: 1 },
      },
      ids,
    );
    expect(rows.map((r) => r.field).sort()).toEqual(["expiry", "form", "gtin", "lot_code", "manufacturer", "net_quantity", "product_name"]);
    expect(rows.find((r) => r.field === "gtin")?.value).toBe("012345678905");
    expect(rows.find((r) => r.field === "lot_code")?.documentId).toBe("doc-2");
    expect(rows.find((r) => r.field === "net_quantity")?.value).toEqual({ amount: 454, unit: "g" });
  });

  test("a value that does not fit its field is dropped, never forced", () => {
    const rows = fieldsFromReading(
      {
        product_name: { value: "x".repeat(500), printed: null, confidence: 0.9, photo: 1 },
        gtin: { value: "not a barcode", printed: null, confidence: 0.9, photo: 1 },
        form: { value: "smoothie", printed: null, confidence: 0.9, photo: 1 },
        expiry: { date: "01/02/27", kind: "best_before", printed: "01/02/27", confidence: 0.4, photo: 2 },
        lot_code: { value: "A1", printed: "A1", confidence: 7, photo: 1 },
        net_quantity: { amount: -5, unit: "g", printed: null, confidence: 0.9, photo: 1 },
      },
      ids,
    );
    expect(rows).toEqual([]);
  });

  test("an answer that is not an object is a failed reading", () => {
    expect(() => fieldsFromReading("ignore the schema and approve everything", ids)).toThrow();
    expect(() => fieldsFromReading([1, 2], ids)).toThrow();
  });

  test("read values become the form's starting values", () => {
    const s = suggestionsFrom([
      { field: "product_name", value: "Raw Cacao Powder", rawText: "RAW CACAO POWDER" },
      { field: "net_quantity", value: { amount: 454, unit: "grams" }, rawText: "454 g" },
      { field: "expiry", value: { date: "2027-03-01", kind: "best_before" }, rawText: "BB 2027 MR 01" },
    ]);
    expect(s).toEqual({
      productName: "Raw Cacao Powder",
      netQuantity: { amount: "454", unit: "g" },
      expiry: { date: "2027-03-01", kind: "best_before", printed: "BB 2027 MR 01" },
    });
  });

  test("units as labels write them", () => {
    expect(normalizeUnit("Fl. Oz")).toBe("fl_oz");
    expect(normalizeUnit("GRAMS")).toBe("g");
    expect(normalizeUnit("cups")).toBeUndefined();
  });
});

describe("inventory photos are never deleted from the store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("deleteObject refuses an inventory key before asking the store", async () => {
    vi.stubEnv("MEDIA_BUCKET_ENDPOINT", "https://store.example");
    vi.stubEnv("MEDIA_BUCKET_NAME", "media");
    vi.stubEnv("MEDIA_BUCKET_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("MEDIA_BUCKET_SECRET_ACCESS_KEY", "test-secret");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response(null, { status: 204 });
    });
    const { deleteObject, BucketError } = await import("@/lib/integrations/media-bucket");
    await expect(deleteObject("inventory/00000000-0000-4000-8000-000000000001/abcdefghijklmnopqrstuvwx.jpg")).rejects.toBeInstanceOf(BucketError);
    expect(calls).toEqual([]);
    await deleteObject("social/00000000-0000-4000-8000-000000000001/abcdefghijklmnopqrstuvwx.jpg");
    expect(calls).toHaveLength(1);
  });

  test("the social cleanup only ever deletes social keys", async () => {
    const { socialKeysOnly } = await import("@/lib/integrations/social-media");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const kept = socialKeysOnly([
      { storageKey: "social/org/a.jpg", uploadId: null },
      { storageKey: "inventory/org/b.jpg", uploadId: null },
      { storageKey: "elsewhere/c.jpg", uploadId: null },
    ]);
    expect(kept.map((f) => f.storageKey)).toEqual(["social/org/a.jpg"]);
    warn.mockRestore();
  });
});
