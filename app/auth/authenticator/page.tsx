import type { Metadata } from "next";
import { requirePendingSignIn } from "@/lib/auth/authorize";
import { safePath } from "@/lib/auth/paths";
import { otpauthUri, readSecret, secondFactorConfigured } from "@/lib/auth/totp";
import { userById } from "@/lib/db/identity";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { signOutAction } from "../../sign-out";
import { authenticatorAction, beginEnrolmentAction, confirmEnrolmentAction } from "../actions";

export const metadata: Metadata = { title: "Authenticator" };

const ERRORS: Record<string, string> = {
  invalid: "That code did not work. Codes change every 30 seconds — try the current one.",
  too_many_attempts: "Too many wrong codes. Wait fifteen minutes, then sign in again.",
  not_enrolled: "Set up your authenticator first.",
};

/**
 * The second step of every sign-in, for a pending session only: the code from
 * the authenticator app (or a recovery code), or — the first time — setting
 * the app up.
 */
export default async function AuthenticatorPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; step?: string }>;
}) {
  const params = await searchParams;
  const next = safePath(params.next);
  const pending = await requirePendingSignIn(next);
  const error = params.error ? ERRORS[params.error] : null;

  const startAgain = (
    <form action={signOutAction} className="mt-4 text-center">
      <CsrfField />
      <button type="submit" className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink-soft">
        Not {pending.email}? Start again
      </button>
    </form>
  );

  if (!secondFactorConfigured()) {
    return (
      <AuthCard
        title="Sign-in is unavailable"
        intro="This deployment has no key for authenticator secrets, so it cannot finish signing anybody in."
      >
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink-soft">
          Set <code className="font-mono text-xs">TOTP_ENC_KEY</code> to a base64-encoded 32-byte key and restart.
        </p>
        {startAgain}
      </AuthCard>
    );
  }

  if (pending.enrolled) {
    return (
      <AuthCard
        title="Enter your authenticator code"
        intro="Open your authenticator app and enter the six digits it shows for 10XiD."
        footer="Lost your phone? Enter one of your recovery codes instead."
      >
        <form action={authenticatorAction}>
          <CsrfField />
          <input type="hidden" name="next" value={next} />
          <label htmlFor="code" className={labelClass}>
            Six-digit code
          </label>
          {/* The pattern allows a recovery code too, so nobody locked out of their phone is told by the browser that their own recovery code is invalid. */}
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
          <SubmitButton>Sign in</SubmitButton>
        </form>
        {startAgain}
      </AuthCard>
    );
  }

  const user = await userById(pending.userId);
  const secret = params.step === "scan" ? readSecret(user?.totpSecret ?? null) : null;

  // No secret issued in this setup yet: offer to start, rather than minting one on a GET.
  if (!secret) {
    return (
      <AuthCard
        title="Set up your authenticator"
        intro="10XiD asks for a code from an authenticator app every time you sign in, so an email on its own is never enough to get into your account."
        footer="Any authenticator app works — 1Password, Authy, Google Authenticator, Microsoft Authenticator."
      >
        <form action={beginEnrolmentAction}>
          <CsrfField />
          <input type="hidden" name="next" value={next} />
          <SubmitButton>Start setup</SubmitButton>
        </form>
        {error ? <FieldError>{error}</FieldError> : null}
        {startAgain}
      </AuthCard>
    );
  }

  const uri = otpauthUri(secret, pending.email);
  return (
    <AuthCard
      title="Set up your authenticator"
      intro="Add 10XiD to your authenticator app, then enter the six digits it shows."
      footer="On your phone, the link opens the app directly. On a computer, type the setup key into the app."
    >
      <div className="mb-5 rounded-lg border border-line bg-sunk p-3">
        <p className={labelClass}>Setup key</p>
        <p className="break-all font-mono text-sm text-ink select-all">{secret.match(/.{1,4}/g)?.join(" ")}</p>
        <a href={uri} className="mt-3 inline-block text-xs font-medium text-brand underline underline-offset-2">
          Open in authenticator app
        </a>
      </div>
      <form action={confirmEnrolmentAction}>
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
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          placeholder="000000"
          className={`${inputClass} text-center text-lg tracking-[0.4em] tabular-nums`}
        />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Confirm and continue</SubmitButton>
      </form>
      {startAgain}
    </AuthCard>
  );
}
