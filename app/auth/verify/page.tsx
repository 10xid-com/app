import type { Metadata } from "next";
import Link from "next/link";
import { safePath } from "@/lib/auth/paths";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { verifyCodeAction } from "../actions";

export const metadata: Metadata = { title: "Enter your code" };

/**
 * Every failure says the same thing: wrong code, expired code, already-used
 * code and unknown address are all "that code did not work".
 */
const ERRORS: Record<string, string> = {
  invalid: "That code did not work. Check it, or request a new one.",
  too_many_attempts: "Too many tries with that code. Request a new one to continue.",
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const email = params.email ?? "";
  const next = safePath(params.next);
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <AuthCard
      title="Check your email"
      intro={
        email ? (
          <>
            If <strong className="text-ink">{email}</strong> has an account or an invitation, we have just emailed it
            a six-digit code, good for ten minutes and one use.
          </>
        ) : (
          "Enter the six-digit code we emailed you."
        )
      }
      footer="Nothing arrived? Check spam, or request another code."
    >
      <form action={verifyCodeAction}>
        <CsrfField />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={next} />
        <label htmlFor="code" className={labelClass}>
          Code from the email
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
        <SubmitButton>Continue</SubmitButton>
      </form>
      <p className="mt-4 text-center text-xs text-ink-faint">
        <Link
          href={`/auth/sign-in?${new URLSearchParams({ next, email }).toString()}`}
          className="underline underline-offset-2 transition-colors hover:text-ink-soft"
        >
          Use a different email, or request a new code
        </Link>
      </p>
    </AuthCard>
  );
}
