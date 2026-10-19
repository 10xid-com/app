"use client";

import { useActionState, useState, useSyncExternalStore, type ReactNode } from "react";
import { CSRF_HEADER } from "@/lib/auth/csrf-names";
import { CsrfInput, CsrfProvider } from "../../../chat/csrf";
import { savePreferredVendorAction, savePurchaseAction, type PurchaseFormState } from "../../purchase-actions";
import { prepare, sha256 } from "../../photo-prep";

/**
 * A container's purchase details — who sold it, when, what this package cost
 * and in which currency, and its invoice or receipt — and where its product
 * is bought from next time. All optional: an empty field is saved as not
 * known, never as a guess, and what was saved before is kept as history.
 *
 * Client forms so a refusal keeps what was typed and says beside the field
 * what is wrong, and so an invoice can be sent (a PDF as it is, a photo
 * redrawn like a label photo) and chosen without leaving the form.
 */

const START: PurchaseFormState = { error: null, field: null, values: null, at: 0 };

/** As the portal will take it: the route refuses more. */
const MAX_BYTES = 9 * 1024 * 1024;

export type PaperworkItem = { id: string; name: string | null; contentType: string; byteSize: number };

export function PurchaseForm({
  containerId,
  csrf,
  version,
  requestKey,
  current,
  paperwork,
  reusable,
  vendors,
  currencies,
  currency,
}: {
  containerId: string;
  csrf: string;
  /** The current record's id, or "-". */
  version: string;
  requestKey: string;
  current: { vendor: string | null; acquiredOn: string | null; price: string | null; currency: string | null; documentId: string | null };
  paperwork: PaperworkItem[];
  reusable: (PaperworkItem & { usedFor: string | null })[];
  vendors: string[];
  currencies: string[];
  currency: string;
}) {
  const [state, act, pending] = useActionState(savePurchaseAction, START);
  // Paperwork sent or picked here stays listed and chosen across a refusal.
  const [docs, setDocs] = useState<PaperworkItem[]>(paperwork);
  const [documentId, setDocumentId] = useState<string>(current.documentId ?? (version === "-" ? (paperwork[0]?.id ?? "") : ""));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const v = state.values;

  async function send(file: File) {
    setSending(true);
    setSendError(null);
    try {
      const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
      const pdf = String.fromCharCode(...head) === "%PDF-";
      // A photo is redrawn like a label photo, so where it was taken never leaves the phone.
      const { blob, name } = pdf ? { blob: file as Blob, name: file.name || "invoice.pdf" } : await prepare(file);
      if (blob.size > MAX_BYTES) throw new Error("That file is over 9MB.");
      const form = new FormData();
      form.append("file", new File([blob], name, { type: pdf ? "application/pdf" : "image/jpeg" }));
      form.append("sha256", await sha256(blob));
      const res = await fetch(`/api/inventory/containers/${containerId}/paperwork`, { method: "POST", headers: { [CSRF_HEADER]: csrf }, body: form });
      const answer = (await res.json().catch(() => ({}))) as Partial<PaperworkItem> & { error?: string };
      if (!res.ok || !answer.id) throw new Error(answer.error ?? "The file could not be sent. Try again.");
      const item: PaperworkItem = { id: answer.id, name: answer.name ?? null, contentType: answer.contentType ?? "", byteSize: answer.byteSize ?? 0 };
      setDocs((d) => [item, ...d.filter((x) => x.id !== item.id)]);
      setDocumentId(item.id);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "The file could not be sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  function reuse(item: PaperworkItem) {
    setDocs((d) => [item, ...d.filter((x) => x.id !== item.id)]);
    setDocumentId(item.id);
  }

  const notYetHere = reusable.filter((r) => !docs.some((d) => d.id === r.id));
  const errorFor = (field: string) => (state.field === field ? state.error : null);

  return (
    <CsrfProvider value={csrf}>
      <form key={state.at} action={act} className="grid gap-3" noValidate>
        <CsrfInput />
        <input type="hidden" name="containerId" value={containerId} />
        <input type="hidden" name="version" value={version} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <input type="hidden" name="documentId" value={documentId} />
        <Today />

        {state.error && !state.field ? (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {state.error}
          </p>
        ) : null}

        <Field label="Bought from" htmlFor="vendor" hint="The shop or company that sold it — not necessarily the maker." error={errorFor("vendor")}>
          <input
            id="vendor"
            name="vendor"
            list={`sellers-${containerId}`}
            defaultValue={v?.vendor ?? current.vendor ?? ""}
            maxLength={200}
            autoComplete="off"
            className={input}
            autoFocus={state.field === "vendor"}
          />
          <datalist id={`sellers-${containerId}`}>
            {vendors.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>

        <Field label="Bought on" htmlFor="acquiredOn" error={errorFor("acquiredOn")}>
          <input
            id="acquiredOn"
            name="acquiredOn"
            type="date"
            defaultValue={v?.acquiredOn ?? current.acquiredOn ?? ""}
            className={input}
            autoFocus={state.field === "acquiredOn"}
          />
        </Field>

        <Field label="Price paid" htmlFor="price" hint="For this package, as charged. Leave empty if you do not know it." error={errorFor("price") ?? errorFor("currency")}>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <input
              id="price"
              name="price"
              defaultValue={v?.price ?? current.price ?? ""}
              inputMode="decimal"
              autoComplete="off"
              placeholder="18.50"
              className={input}
              autoFocus={state.field === "price"}
            />
            <select
              name="currency"
              aria-label="Currency"
              defaultValue={v?.currency ?? current.currency ?? currency}
              className={input}
              autoFocus={state.field === "currency"}
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </Field>

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium text-ink">Invoice or receipt</legend>
          {errorFor("documentId") ? <p className="text-sm text-bad">{errorFor("documentId")}</p> : null}
          <div role="radiogroup" aria-label="Invoice or receipt" className="grid gap-2">
            {docs.map((d) => (
              <Pick key={d.id} on={documentId === d.id} onPick={() => setDocumentId(d.id)}>
                <span className="min-w-0 flex-1 break-words">{d.name ?? "Invoice or receipt"}</span>
                <span className="text-xs text-ink-soft">
                  {kindOf(d.contentType)} · {size(d.byteSize)}
                </span>
                <a href={`/api/inventory/documents/${d.id}`} target="_blank" rel="noopener" className="text-sm font-medium text-brand underline">
                  Open
                </a>
              </Pick>
            ))}
            <Pick on={documentId === ""} onPick={() => setDocumentId("")}>
              <span className="flex-1">None</span>
            </Pick>
          </div>
          <label
            className={`flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface px-4 py-2 text-base font-semibold text-ink hover:bg-sunk ${sending ? "opacity-60" : ""}`}
          >
            <input
              type="file"
              accept="application/pdf,image/*"
              className="sr-only"
              disabled={sending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void send(file);
              }}
            />
            {sending ? "Sending…" : "Add a PDF or a photo"}
          </label>
          {sendError ? (
            <p role="alert" className="text-sm text-bad">
              {sendError}
            </p>
          ) : null}
          {notYetHere.length ? (
            <details className="rounded-xl border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium text-ink">Use one already sent</summary>
              <ul className="mt-2 grid gap-2">
                {notYetHere.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="min-w-0 flex-1 break-words text-ink">
                      {r.name ?? "Invoice or receipt"}
                      <span className="block text-xs text-ink-soft">
                        {kindOf(r.contentType)} · {size(r.byteSize)}
                        {r.usedFor ? ` · for ${r.usedFor}` : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => reuse(r)}
                      className="min-h-11 rounded-lg border border-line bg-surface px-3 py-1 text-sm font-semibold text-ink hover:bg-sunk"
                    >
                      Use this one
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </fieldset>

        <button
          type="submit"
          disabled={pending || sending}
          aria-busy={pending}
          className="min-h-12 w-full rounded-xl border border-line bg-surface px-5 py-3 text-base font-semibold text-ink hover:bg-sunk disabled:opacity-60 sm:w-auto"
        >
          {pending ? "Saving…" : "Save purchase details"}
        </button>
      </form>
    </CsrfProvider>
  );
}

/** Where this product is bought from next time. */
export function PreferredForm({
  containerId,
  csrf,
  version,
  current,
  vendors,
}: {
  containerId: string;
  csrf: string;
  version: string;
  current: string | null;
  vendors: string[];
}) {
  const [state, act, pending] = useActionState(savePreferredVendorAction, START);
  return (
    <CsrfProvider value={csrf}>
      <form key={state.at} action={act} className="grid gap-3" noValidate>
        <CsrfInput />
        <input type="hidden" name="containerId" value={containerId} />
        <input type="hidden" name="version" value={version} />
        {state.error && state.field !== "vendor" ? (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {state.error}
          </p>
        ) : null}
        <Field
          label="Next time, buy from"
          htmlFor="preferredVendor"
          hint="Leave empty for no preferred seller. Other sellers listed for it stay as they are."
          error={state.field === "vendor" ? state.error : null}
        >
          <input
            id="preferredVendor"
            name="vendor"
            list={`preferred-${containerId}`}
            defaultValue={state.values?.vendor ?? current ?? ""}
            maxLength={200}
            autoComplete="off"
            className={input}
            autoFocus={state.field === "vendor"}
          />
          <datalist id={`preferred-${containerId}`}>
            {vendors.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="min-h-12 w-full rounded-xl border border-line bg-surface px-5 py-3 text-base font-semibold text-ink hover:bg-sunk disabled:opacity-60 sm:w-auto"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </form>
    </CsrfProvider>
  );
}

/* ------------------------------------------------------------------ */

const never = () => () => {};

/** The phone's own date (YYYY-MM-DD): a purchase date cannot be after it. */
function Today() {
  const today = useSyncExternalStore(
    never,
    () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    },
    () => "",
  );
  return <input type="hidden" name="today" value={today} />;
}

const kindOf = (contentType: string) => (contentType === "application/pdf" ? "PDF" : "Photo");

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const input =
  "w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:outline-2 focus:outline-brand/30";

function Pick({ on, onPick, children }: { on: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <label
      className={`flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-base ${
        on ? "border-brand bg-brand/10 text-ink" : "border-line bg-surface text-ink-soft"
      } focus-within:outline-2 focus-within:outline-brand`}
    >
      <input type="radio" name="documentChoice" checked={on} onChange={onPick} className="h-5 w-5 accent-brand" />
      {children}
    </label>
  );
}

function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? <p className="text-sm text-bad">{error}</p> : hint ? <p className="text-xs text-ink-soft">{hint}</p> : null}
    </div>
  );
}
