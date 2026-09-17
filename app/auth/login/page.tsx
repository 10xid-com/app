import type { Metadata } from "next";
import Link from "next/link";
import { requestCodeAction } from "../actions";
import {
  AuthCard,
  FieldError,
  SubmitButton,
  inputClass,
  labelClass,
} from "../auth-card";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  email: "That does not look like an email address. Check it and try again.",
  rate: "Too many codes requested for that address. Wait a few minutes and try again.",
};

/**
 * Signing in — for somebody who already has an account.
 *
 * The screen describes both ways a code can reach you without saying which
 * applies to the address being typed. It cannot know yet, and it must not tell:
 * a form that greeted an enrolled address differently would be a way to
 * discover who has an account and which people are staff.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;
  const next = params.next ?? "/";

  return (
    <AuthCard
      title="Sign in"
      intro="Enter your email. If you have set up an authenticator app, the next screen takes the code it shows; otherwise we will email you one. There is no password."
      footer="Codes are single use. Nothing is stored that could be replayed later."
    >
      <form action={requestCodeAction}>
        <input type="hidden" name="next" value={next} />

        <label htmlFor="email" className={labelClass}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={params.email ?? ""}
          placeholder="you@company.com"
          className={inputClass}
        />

        {error ? <FieldError>{error}</FieldError> : null}

        <SubmitButton>Continue</SubmitButton>
      </form>

      <div className="mt-6 border-t border-line-soft pt-5">
        <p className="text-sm font-medium text-ink">First time here?</p>
        <p className="mt-1 text-sm text-ink-soft">
          If Branding Centres has invited you, set your account up once and then
          sign in with an authenticator from then on.
        </p>
        <Link
          href={`/auth/signup?next=${encodeURIComponent(next)}`}
          className="mt-3 inline-block rounded-lg border border-line px-4 py-2
                     text-sm font-semibold text-ink transition-colors duration-150
                     hover:bg-sunk focus-visible:outline-2
                     focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Set up your account
        </Link>
      </div>
    </AuthCard>
  );
}
