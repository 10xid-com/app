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
      title="Check your email"
      intro={
        email ? (
          <>
            We sent a six-digit code to <strong className="text-ink">{email}</strong>.
            It expires in ten minutes and works once.
          </>
        ) : (
          "Enter the six-digit code we sent you."
        )
      }
      footer="Didn't arrive? Check spam, or request another code."
    >
      <form action={verifyCodeAction}>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={params.next ?? "/"} />

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

        <SubmitButton>Sign in</SubmitButton>
      </form>

      <p className="mt-4 text-center text-xs text-ink-faint">
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
