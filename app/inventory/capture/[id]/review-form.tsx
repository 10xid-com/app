"use client";

import { useActionState, useState, useSyncExternalStore, type ReactNode } from "react";
import { CsrfInput, CsrfProvider } from "../../../chat/csrf";
import { saveCaptureAction, type ReviewState } from "../../actions";
import type { ReviewField } from "@/lib/inventory/review";
import { outstandingFor, subscribeOutstanding } from "./photo-queue";

/**
 * Check what was read, fix it, save it.
 *
 * Every value starts as what the label reader found (marked as read from the
 * photos, with how sure it was) or empty, and nothing is invented to fill a
 * gap: a lot, a date or an amount nobody knows is left out and saved as
 * unknown. How much is in the container is said one of four honest ways —
 * as the sealed label says, weighed, about, or not known — and the database
 * holds each to what it is (a scale's net with a weighed empty weight is the
 * only "weighed" amount). Whether it is sealed, and how the amount is known,
 * start unanswered: they are the person's statement about this container, so
 * no default can make them.
 *
 * Save waits while this item's photos are still on their way (the photo
 * queue): saved first, they would never be sent.
 *
 * A client form so that a refusal keeps everything typed: on a phone this is
 * a long form, and the reason appears beside the field it is about.
 */

export type ProductOption = { id: string; name: string; brand: string | null; detail: string; match: number };

type Values = Partial<Record<ReviewField, string>>;

const START: ReviewState = { error: null, field: null, values: null, at: 0 };

const UNIT_OPTIONS: [string, string][] = [
  ["g", "g"],
  ["kg", "kg"],
  ["mg", "mg"],
  ["oz", "oz"],
  ["lb", "lb"],
  ["ml", "ml"],
  ["l", "L"],
  ["fl_oz", "fl oz"],
  ["count", "items"],
];

const FORMS: [string, string][] = [
  ["unknown", "Not sure"],
  ["powder", "Powder"],
  ["extract_powder", "Extract powder"],
  ["juice_powder", "Juice powder"],
  ["granules", "Granules"],
  ["crystals", "Crystals"],
  ["whole", "Whole"],
  ["cut", "Cut"],
  ["liquid", "Liquid"],
  ["capsules", "Capsules"],
  ["tablets", "Tablets"],
  ["other", "Other"],
];

const EXPIRY_KINDS: [string, string][] = [
  ["best_before", "Best before"],
  ["expiry", "Expires"],
  ["use_by", "Use by"],
  ["unknown", "Not sure"],
];

export function ReviewForm({
  captureId,
  csrf,
  initial,
  read,
  products,
  evidenceWarning,
}: {
  captureId: string;
  csrf: string;
  initial: Values;
  /** For fields the reader filled: how sure it was (0–1), or null when it did not say. */
  read: Partial<Record<ReviewField, number | null>>;
  products: ProductOption[];
  /** Set when a photo is already evidence for a saved container. */
  evidenceWarning: ReactNode;
}) {
  const [state, save, pending] = useActionState(saveCaptureAction, START);
  // What was typed comes back with a refusal; otherwise what was read.
  const values: Values = state.values ?? initial;
  return (
    <CsrfProvider value={csrf}>
      <FormBody
        key={state.at}
        captureId={captureId}
        values={values}
        read={state.values ? {} : read}
        products={products}
        state={state}
        save={save}
        pending={pending}
        evidenceWarning={evidenceWarning}
      />
    </CsrfProvider>
  );
}

function FormBody({
  captureId,
  values,
  read,
  products,
  state,
  save,
  pending,
  evidenceWarning,
}: {
  captureId: string;
  values: Values;
  read: Partial<Record<ReviewField, number | null>>;
  products: ProductOption[];
  state: ReviewState;
  save: (data: FormData) => void;
  pending: boolean;
  evidenceWarning: ReactNode;
}) {
  const [product, setProduct] = useState(values.product ?? "new");
  const [status, setStatus] = useState(values.status ?? "");
  const [amount, setAmount] = useState(values.amount ?? "");
  // Null until the photo queue on this phone has been looked in.
  const unsent = useSyncExternalStore(subscribeOutstanding, () => outstandingFor(captureId), () => null);
  const waitingForPhotos = unsent === null || unsent > 0;
  const [single, setSingle] = useState(values.single === "on");
  const [hasLabel, setHasLabel] = useState(Boolean(values.labelQuantity));
  const isNew = product === "new";

  const errorFor = (field: ReviewField) => (state.field === field ? state.error : null);

  return (
    <form action={save} className="grid gap-6" noValidate>
      <CsrfInput />
      <input type="hidden" name="captureId" value={captureId} />

      {state.error && !state.field ? (
        <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      ) : state.error ? (
        <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          Something needs another look: {state.error}
        </p>
      ) : null}

      {evidenceWarning}

      <Fieldset legend="What is it">
        {products.length ? (
          <Field label="Product" htmlFor="product" error={errorFor("product")}>
            <select id="product" name="product" value={product} onChange={(e) => setProduct(e.target.value)} className={input}>
              <option value="new">A new product</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.match === 2 ? "Same barcode: " : p.match === 1 ? "Same name: " : ""}
                  {p.name}
                  {p.brand ? ` — ${p.brand}` : ""}
                  {p.detail ? ` (${p.detail})` : ""}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <input type="hidden" name="product" value="new" />
        )}

        {/* Kept in the form either way, so what was read is still compared when an existing product is chosen. */}
        <div className={isNew ? "grid gap-4" : "hidden"}>
          <Field label="Name" htmlFor="productName" read={read.productName} error={errorFor("productName")}>
            <input id="productName" name="productName" defaultValue={values.productName ?? ""} maxLength={200} autoComplete="off" className={input} />
          </Field>
          <Field label="Brand" htmlFor="brand" read={read.brand}>
            <input id="brand" name="brand" defaultValue={values.brand ?? ""} maxLength={200} autoComplete="off" className={input} />
          </Field>
          <Field
            label="Made by"
            htmlFor="manufacturer"
            read={read.manufacturer}
            hint="The company printed as the maker. A new one is listed with its own 10XiD iD; it gets no access to anything."
          >
            <input id="manufacturer" name="manufacturer" defaultValue={values.manufacturer ?? ""} maxLength={200} autoComplete="off" className={input} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Form" htmlFor="form" read={read.form}>
              <select id="form" name="form" defaultValue={values.form ?? "unknown"} className={input}>
                {FORMS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Barcode" htmlFor="gtin" read={read.gtin} error={errorFor("gtin")}>
              <input id="gtin" name="gtin" defaultValue={values.gtin ?? ""} inputMode="numeric" autoComplete="off" maxLength={20} className={input} />
            </Field>
          </div>
          <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              name="single"
              checked={single}
              onChange={(e) => setSingle(e.target.checked)}
              className="mt-0.5 h-5 w-5 flex-none accent-brand"
            />
            <span>
              It is one ingredient
              <span className="block text-ink-soft">The whole contents is one thing (pure cacao powder, not a blend), so it can be counted toward recipes.</span>
            </span>
          </label>
          {single ? (
            <Field label="Ingredient" htmlFor="materialName" hint="Leave empty to use the name." error={errorFor("materialName")}>
              <input id="materialName" name="materialName" defaultValue={values.materialName ?? ""} maxLength={200} autoComplete="off" className={input} />
            </Field>
          ) : null}
        </div>
      </Fieldset>

      <Fieldset legend="The label">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Net contents" htmlFor="labelQuantity" read={read.labelQuantity} error={errorFor("labelQuantity") ?? errorFor("labelUnit")}>
            <input
              id="labelQuantity"
              name="labelQuantity"
              defaultValue={values.labelQuantity ?? ""}
              inputMode="decimal"
              autoComplete="off"
              placeholder="500"
              onChange={(e) => setHasLabel(e.target.value.trim() !== "")}
              className={input}
            />
          </Field>
          <Field label="Unit" htmlFor="labelUnit">
            <select id="labelUnit" name="labelUnit" defaultValue={values.labelUnit ?? ""} className={input}>
              <option value="">—</option>
              {UNIT_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Lot" htmlFor="lotCode" read={read.lotCode}>
          <input id="lotCode" name="lotCode" defaultValue={values.lotCode ?? ""} maxLength={100} autoComplete="off" className={input} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date as printed" htmlFor="expiryPrinted" read={read.expiryPrinted}>
            <input id="expiryPrinted" name="expiryPrinted" defaultValue={values.expiryPrinted ?? ""} maxLength={100} autoComplete="off" className={input} />
          </Field>
          <Field label="Date" htmlFor="expiryDate" read={read.expiryDate} error={errorFor("expiryDate")}>
            <input id="expiryDate" name="expiryDate" type="date" defaultValue={values.expiryDate ?? ""} className={input} />
          </Field>
          <Field label="Which date" htmlFor="expiryKind">
            <select id="expiryKind" name="expiryKind" defaultValue={values.expiryKind ?? "unknown"} className={input}>
              {EXPIRY_KINDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="This container">
        {errorFor("status") ? <p className="text-sm text-bad">{errorFor("status")}</p> : null}
        <div role="radiogroup" aria-label="Sealed or opened" className="grid grid-cols-2 gap-2">
          {(["sealed", "open"] as const).map((s) => (
            <label key={s} className={choice(status === s)}>
              <input
                type="radio"
                name="status"
                value={s}
                checked={status === s}
                onChange={() => {
                  setStatus(s);
                  if (s === "open" && amount === "label") setAmount("");
                }}
                className="sr-only"
              />
              {s === "sealed" ? "Sealed" : "Opened"}
            </label>
          ))}
        </div>

        <div>
          <p className="text-sm font-medium text-ink">How much is in it?</p>
          {errorFor("amount") ? <p className="mt-1 text-sm text-bad">{errorFor("amount")}</p> : null}
          <div role="radiogroup" aria-label="How much is in it" className="mt-2 grid gap-2">
            <AmountChoice value="label" current={amount} onPick={setAmount} disabled={status !== "sealed" || !hasLabel}>
              What the label says{status !== "sealed" ? " (sealed only)" : !hasLabel ? " (fill in the net contents)" : ""}
            </AmountChoice>
            <AmountChoice value="weighed" current={amount} onPick={setAmount}>
              I weighed it
            </AmountChoice>
            {amount === "weighed" ? (
              <div className="grid gap-3 rounded-xl bg-sunk p-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="On the scale (g)" htmlFor="grossG" error={errorFor("grossG")}>
                    <input id="grossG" name="grossG" defaultValue={values.grossG ?? ""} inputMode="decimal" autoComplete="off" className={input} />
                  </Field>
                  <Field label="Empty container (g)" htmlFor="tareG" error={errorFor("tareG")}>
                    <input id="tareG" name="tareG" defaultValue={values.tareG ?? ""} inputMode="decimal" autoComplete="off" className={input} />
                  </Field>
                </div>
                <Field label="The empty weight is" htmlFor="tareBasis" error={errorFor("tareBasis")} hint="Only a weighed empty container makes the amount a weighed one. Without an empty weight, what is inside stays unknown.">
                  <select id="tareBasis" name="tareBasis" defaultValue={values.tareBasis ?? ""} className={input}>
                    <option value="">Choose…</option>
                    <option value="measured">Weighed (an identical empty container, or this one before filling)</option>
                    <option value="estimated">An estimate</option>
                  </select>
                </Field>
              </div>
            ) : null}
            <AmountChoice value="estimate" current={amount} onPick={setAmount}>
              About…
            </AmountChoice>
            {amount === "estimate" ? (
              <div className="grid grid-cols-[1fr_auto] gap-3 rounded-xl bg-sunk p-3">
                <Field label="About" htmlFor="estimateQuantity" error={errorFor("estimateQuantity")}>
                  <input id="estimateQuantity" name="estimateQuantity" defaultValue={values.estimateQuantity ?? ""} inputMode="decimal" autoComplete="off" className={input} />
                </Field>
                <Field label="Unit" htmlFor="estimateUnit" error={errorFor("estimateUnit")}>
                  <select id="estimateUnit" name="estimateUnit" defaultValue={values.estimateUnit ?? values.labelUnit ?? "g"} className={input}>
                    {UNIT_OPTIONS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ) : null}
            <AmountChoice value="unknown" current={amount} onPick={setAmount}>
              I don’t know yet
            </AmountChoice>
          </div>
        </div>

        <Field label="Where is it?" htmlFor="location" hint="A shelf, a cupboard, a fridge. Optional.">
          <input id="location" name="location" defaultValue={values.location ?? ""} maxLength={100} autoComplete="off" className={input} />
        </Field>
        <Field label="Notes" htmlFor="notes">
          <textarea id="notes" name="notes" defaultValue={values.notes ?? ""} rows={2} maxLength={2000} className={input} />
        </Field>
      </Fieldset>

      {unsent === null ? (
        <p role="status" className="text-sm text-ink-soft">
          Checking this phone for photos still to send…
        </p>
      ) : unsent > 0 ? (
        <p role="status" className="text-sm text-ink-soft">
          {unsent === 1 ? "1 photo is" : `${unsent} photos are`} still on the way. Save is ready once {unsent === 1 ? "it has" : "they have"} arrived.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || waitingForPhotos}
        aria-busy={pending}
        className="min-h-14 w-full rounded-xl bg-brand-surface px-5 py-3 text-base font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {pending ? "Saving…" : "Save to inventory"}
      </button>
    </form>
  );
}

const input =
  "w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:outline-2 focus:outline-brand/30";

const choice = (on: boolean) =>
  `flex min-h-12 cursor-pointer items-center justify-center rounded-xl border px-3 py-2 text-base font-medium ${
    on ? "border-brand bg-brand/10 text-ink" : "border-line bg-surface text-ink-soft"
  } focus-within:outline-2 focus-within:outline-brand`;

function AmountChoice({
  value,
  current,
  onPick,
  disabled = false,
  children,
}: {
  value: string;
  current: string;
  onPick: (v: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`${choice(current === value)} justify-start ${disabled ? "cursor-not-allowed opacity-50" : ""}`}>
      <input
        type="radio"
        name="amount"
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => onPick(value)}
        className="mr-3 h-5 w-5 accent-brand"
      />
      {children}
    </label>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
      <legend className="px-1 text-lg font-semibold text-ink">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  read,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  /** Present when the label reader filled this in: how sure it was. */
  read?: number | null;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-ink">
        {label}
        {read !== undefined ? (
          <span className={`text-xs font-normal ${read !== null && read < 0.7 ? "text-warn" : "text-ink-faint"}`}>
            {read !== null && read < 0.7 ? "read from the photos — check this" : "read from the photos"}
          </span>
        ) : null}
      </label>
      {children}
      {error ? <p className="text-sm text-bad">{error}</p> : hint ? <p className="text-xs text-ink-soft">{hint}</p> : null}
    </div>
  );
}
