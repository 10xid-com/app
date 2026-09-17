import type { Metadata } from "next";
import Link from "next/link";
import { verifyCodeAction } from "../actions";
import {
  AuthCard,
  FieldError,
  SubmitButton,
  inputClass,
  labelClass,
} from "../auth-card";

export const metadata: Metadata = { title: "Enter your code" };

/**
 * Every failure says the same thing.
 *
 * Wrong code, expired code, already-used code and unknown address are all
 * "that code did not work" — telling them apart would let someone at the form
 * discover which addresses have accounts and which codes are still live.
 */
const ERRORS: Record<string, string> = {
  invalid: "That code did not work. Check it, or request a new one.",
  too_many_attempts:
    "Too many tries with that code. Request a new one to continue.",
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const email = params.email ?? "";
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <AuthCard
      title="Enter your code"
      /*
        Deliberately covers both ways in without saying which applies to this
        address. The page cannot ask, and must not: one that greeted an
        authenticator holder differently would be a way to discover which
        addresses have accounts and which people are staff, just by typing
        addresses into the form and watching how it answers.
      */
      intro={
        email ? (
          <>
            If <strong className="text-ink">{email}</strong> uses an
            authenticator app, enter the code it is showing. Otherwise we have
            just emailed a six-digit code, good for ten minutes and one use.
          </>
        ) : (
          "Enter the six-digit code from your authenticator app, or the one we emailed you."
        )
      }
      footer="Expecting an email? Check spam, or request another code."
    >
      <form action={verifyCodeAction}>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={params.next ?? "/"} />

        <label htmlFor="code" className={labelClass}>
          Six-digit code
        </label>
        {/*
          The pattern allows a recovery code too. Constraining this to six
          digits would mean somebody locked out of their phone gets a browser
          tooltip telling them their own recovery code is invalid, before the
          form is ever submitted.
        */}
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}|[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}"
          maxLength={9}
          required
          autoFocus
          placeholder="000000"
          className={`${inputClass} text-center text-lg tracking-[0.4em] tabular-nums`}
        />

        {error ? <FieldError>{error}</FieldError> : null}

        <SubmitButton>Sign in</SubmitButton>
      </form>

      <p className="mt-4 text-center text-xs text-ink-faint">
        Lost your authenticator? Enter one of your recovery codes above instead.
      </p>

      <p className="mt-2 text-center text-xs text-ink-faint">
        <Link
          href={`/auth/login?next=${encodeURIComponent(params.next ?? "/")}&email=${encodeURIComponent(email)}`}
          className="underline underline-offset-2 hover:text-ink-soft transition-colors"
        >
          Use a different email, or request a new code
        </Link>
      </p>
    </AuthCard>
  );
}
