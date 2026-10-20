import type { Metadata } from "next";
import { requireSignedIn } from "@/lib/auth/authorize";
import { safePath } from "@/lib/auth/paths";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { confirmAction } from "../actions";

export const metadata: Metadata = { title: "Confirm it is you" };

const ERRORS: Record<string, string> = {
  invalid: "That code did not work. Codes change every 30 seconds — try the current one.",
  too_many_attempts: "Too many wrong codes. Wait fifteen minutes and try again.",
  not_enrolled: "This account has no authenticator set up.",
};

/**
 * "Confirm it is you": a fresh authenticator code, for what needs one recent
 * (lib/auth/policy.ts FRESHNESS_SECONDS), then back to where the person was.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  const next = safePath(params.next);
  await requireSignedIn(`/auth/confirm?next=${encodeURIComponent(next)}`);
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <AuthCard
      title="Confirm it is you"
      intro="This needs a recent code from your authenticator app."
      footer="Lost your phone? A recovery code works here too."
    >
      <form action={confirmAction}>
        <CsrfField />
        <input type="hidden" name="next" value={next} />
        <label htmlFor="code" className={labelClass}>
          Six-digit code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}|[0-9A-Za-z]{4}[\-\s]?[0-9A-Za-z]{4}"
          maxLength={9}
          required
          autoFocus
          placeholder="000000"
          className={`${inputClass} text-center text-lg tracking-[0.4em] tabular-nums`}
        />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Confirm</SubmitButton>
      </form>
    </AuthCard>
  );
}
