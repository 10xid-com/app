"use client";

import { useActionState, useState, useSyncExternalStore, type ReactNode } from "react";
import { CsrfInput, CsrfProvider } from "../../../chat/csrf";
import { recordAmountAction, saveContainerDetailsAction, type ContainerFormState } from "../../actions";

/**
 * The container page's forms: what is in it now, opening it, where it is.
 *
 * Client forms so a refusal keeps what was typed and says beside the field
 * what is wrong; a stale page or a form already sent says so instead of
 * saving over someone else's change. Each carries the version of the
 * container the page showed and, for an amount, the request key the page was
 * drawn with (app/inventory/actions.ts → lib/db/inventory.ts).
 */

const START: ContainerFormState = { error: null, field: null, values: null, at: 0 };

type UnitOption = { code: string; label: string };

/** "What is in it now": about how much, or weighed. Also opening a package whose amount was its label. */
export function AmountForm({
  containerId,
  csrf,
  version,
  requestKey,
  intent,
  units,
  canWeigh,
  tare,
  submitLabel,
}: {
  containerId: string;
  csrf: string;
  version: string;
  requestKey: string;
  intent: "amount" | "open";
  /** Units of the container's own kind, its base unit first. */
  units: UnitOption[];
  /** Only a container measured by mass can be weighed. */
  canWeigh: boolean;
  /** The empty container's weight, when it is known, to start the weighing from. */
  tare: { g: string; basis: "measured" | "estimated" } | null;
  submitLabel: string;
}) {
  const [state, act, pending] = useActionState(recordAmountAction, START);
  return (
    <CsrfProvider value={csrf}>
      <AmountBody
        key={state.at}
        state={state}
        act={act}
        pending={pending}
        containerId={containerId}
        version={version}
        requestKey={requestKey}
        intent={intent}
        units={units}
        canWeigh={canWeigh}
        tare={tare}
        submitLabel={submitLabel}
      />
    </CsrfProvider>
  );
}

function AmountBody({
  state,
  act,
  pending,
  containerId,
  version,
  requestKey,
  intent,
  units,
  canWeigh,
  tare,
  submitLabel,
}: {
  state: ContainerFormState;
  act: (data: FormData) => void;
  pending: boolean;
  containerId: string;
  version: string;
  requestKey: string;
  intent: "amount" | "open";
  units: UnitOption[];
  canWeigh: boolean;
  tare: { g: string; basis: "measured" | "estimated" } | null;
  submitLabel: string;
}) {
  const v = state.values ?? {};
  const [amount, setAmount] = useState(v.amount ?? (canWeigh ? "" : "estimate"));
  const errorFor = (field: string) => (state.field === field ? state.error : null);
  return (
    <form action={act} className="grid gap-3" noValidate>
      <CsrfInput />
      <input type="hidden" name="containerId" value={containerId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <input type="hidden" name="intent" value={intent} />
      <Today />

      {state.error && (!state.field || state.field === "amount") ? (
        <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      ) : null}

      <div role="radiogroup" aria-label="How do you know the amount" className="grid gap-2">
        <Choice name="amount" value="estimate" current={amount} onPick={setAmount}>
          About…
        </Choice>
        {amount === "estimate" ? (
          <div className="grid grid-cols-[1fr_auto] gap-3 rounded-xl bg-sunk p-3">
            <Field label="About" htmlFor={`${intent}-estimateQuantity`} error={errorFor("estimateQuantity")}>
              <input
                id={`${intent}-estimateQuantity`}
                name="estimateQuantity"
                defaultValue={v.estimateQuantity ?? ""}
                inputMode="decimal"
                autoComplete="off"
                className={input}
              />
            </Field>
            <Field label="Unit" htmlFor={`${intent}-estimateUnit`} error={errorFor("estimateUnit")}>
              <select id={`${intent}-estimateUnit`} name="estimateUnit" defaultValue={v.estimateUnit ?? units[0]?.code} className={input}>
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
        {canWeigh ? (
          <Choice name="amount" value="weighed" current={amount} onPick={setAmount}>
            I weighed it
          </Choice>
        ) : null}
        {canWeigh && amount === "weighed" ? (
          <div className="grid gap-3 rounded-xl bg-sunk p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="On the scale (g)" htmlFor={`${intent}-grossG`} error={errorFor("grossG")}>
                <input id={`${intent}-grossG`} name="grossG" defaultValue={v.grossG ?? ""} inputMode="decimal" autoComplete="off" className={input} />
              </Field>
              <Field label="Empty container (g)" htmlFor={`${intent}-tareG`} error={errorFor("tareG")}>
                <input
                  id={`${intent}-tareG`}
                  name="tareG"
                  defaultValue={v.tareG ?? (tare ? Number(tare.g).toString() : "")}
                  inputMode="decimal"
                  autoComplete="off"
                  className={input}
                />
              </Field>
            </div>
            <Field
              label="The empty weight is"
              htmlFor={`${intent}-tareBasis`}
              error={errorFor("tareBasis")}
              hint="Only a weighed empty container makes the amount a weighed one."
            >
              <select id={`${intent}-tareBasis`} name="tareBasis" defaultValue={v.tareBasis ?? tare?.basis ?? ""} className={input}>
                <option value="">Choose…</option>
                <option value="measured">Weighed</option>
                <option value="estimated">An estimate</option>
              </select>
            </Field>
          </div>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="min-h-12 w-full rounded-xl bg-brand-surface px-5 py-3 text-base font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-60 sm:w-auto"
      >
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

/** Opening a container whose amount stays as it is (an estimate, a weighing, or unknown). */
export function OpenForm({ containerId, csrf, version, requestKey }: { containerId: string; csrf: string; version: string; requestKey: string }) {
  const [state, act, pending] = useActionState(recordAmountAction, START);
  return (
    <CsrfProvider value={csrf}>
      <form action={act} className="grid gap-2">
        <CsrfInput />
        <input type="hidden" name="containerId" value={containerId} />
        <input type="hidden" name="version" value={version} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <input type="hidden" name="intent" value="open" />
        <input type="hidden" name="amount" value="" />
        <Today />
        {state.error ? (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {state.error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="min-h-12 w-full rounded-xl border border-line bg-surface px-5 py-3 text-base font-semibold text-ink hover:bg-sunk disabled:opacity-60 sm:w-auto"
        >
          {pending ? "Saving…" : "Mark opened"}
        </button>
      </form>
    </CsrfProvider>
  );
}

/** Where it is, and anything to remember about it. */
export function DetailsForm({
  containerId,
  csrf,
  version,
  location,
  notes,
}: {
  containerId: string;
  csrf: string;
  version: string;
  location: string | null;
  notes: string | null;
}) {
  const [state, act, pending] = useActionState(saveContainerDetailsAction, START);
  const v = state.values;
  return (
    <CsrfProvider value={csrf}>
      <form key={state.at} action={act} className="grid gap-3" noValidate>
        <CsrfInput />
        <input type="hidden" name="containerId" value={containerId} />
        <input type="hidden" name="version" value={version} />
        {state.error && !state.field ? (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {state.error}
          </p>
        ) : null}
        <Field label="Where is it?" htmlFor="location" hint="A shelf, a cupboard, a fridge." error={state.field === "location" ? state.error : null}>
          <input id="location" name="location" defaultValue={v?.location ?? location ?? ""} maxLength={100} autoComplete="off" className={input} />
        </Field>
        <Field label="Notes" htmlFor="notes" error={state.field === "notes" ? state.error : null}>
          <textarea id="notes" name="notes" defaultValue={v?.notes ?? notes ?? ""} rows={3} maxLength={2000} className={input} />
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

/** The phone's own date (YYYY-MM-DD), for the day a container was opened. */
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

/**
 * A moment, in the reader's own time zone once the page is running. Before
 * that (the server's HTML, and hydrating it) it is spelled out in UTC by hand,
 * so the server and the browser cannot disagree about it.
 */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    never,
    () => new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
    () => {
      const d = new Date(iso);
      const two = (n: number) => String(n).padStart(2, "0");
      return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
    },
  );
  return <time dateTime={iso}>{text}</time>;
}

const input =
  "w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:outline-2 focus:outline-brand/30";

function Choice({ name, value, current, onPick, children }: { name: string; value: string; current: string; onPick: (v: string) => void; children: ReactNode }) {
  const on = current === value;
  return (
    <label
      className={`flex min-h-12 cursor-pointer items-center rounded-xl border px-3 py-2 text-base font-medium ${
        on ? "border-brand bg-brand/10 text-ink" : "border-line bg-surface text-ink-soft"
      } focus-within:outline-2 focus-within:outline-brand`}
    >
      <input type="radio" name={name} value={value} checked={on} onChange={() => onPick(value)} className="mr-3 h-5 w-5 accent-brand" />
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
