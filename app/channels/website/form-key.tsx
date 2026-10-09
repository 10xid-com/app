"use client";

import { useActionState, useState } from "react";
import { CsrfInput, CsrfProvider } from "../../chat/csrf";
import { SubmitButton } from "../../_components/submit-button";
import { mintFormKeyAction, type FormKeyState } from "./actions";

/**
 * Make a key for the website's forms, and show it once.
 *
 * A client component only so the key can come back in the action's answer
 * and be shown here, rather than travelling in the address. Leaving or
 * reloading the page loses it for good: it is stored only as a hash.
 */
export function MintFormKey({ csrfToken }: { csrfToken: string }) {
  const [state, mint] = useActionState<FormKeyState, FormData>(mintFormKeyAction, { secret: null, error: null });
  const [copied, setCopied] = useState(false);

  if (state.secret) {
    return (
      <div className="grid gap-3 rounded-xl border border-warn/40 bg-warn/5 p-4">
        <p className="text-sm font-semibold text-ink">Copy this key now. It will not be shown again.</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">
            {state.secret}
          </code>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(state.secret!);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
            className="rounded-lg bg-brand-surface px-3 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-ink-soft">
          Save it on the website&rsquo;s server as a secret named <code className="font-mono">TENXID_INTAKE_KEY</code>.
          Never put it in the website&rsquo;s pages or code: anybody could read it there.
        </p>
      </div>
    );
  }

  return (
    <CsrfProvider value={csrfToken}>
    <form action={mint} className="flex flex-wrap items-end gap-3">
      <CsrfInput />
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium text-ink">Name</span>
        <input
          name="label"
          defaultValue="Website forms"
          maxLength={80}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-ink"
        />
      </label>
      <SubmitButton
        pendingLabel="Making…"
        className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-60"
      >
        Make a key
      </SubmitButton>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-bad">
          {state.error}
        </p>
      ) : null}
    </form>
    </CsrfProvider>
  );
}
