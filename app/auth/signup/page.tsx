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

export const metadata: Metadata = { title: "Set up your account" };

const ERRORS: Record<string, string> = {
  email: "That does not look like an email address. Check it and try again.",
  rate: "Too many codes requested for that address. Wait a few minutes and try again.",
};

/**
 * Setting an account up for the first time.
 *
 * Deliberately NOT open registration. A portal holds several companies' data,
 * and an address typed into a form says nothing about which company its owner
 * belongs to — letting a stranger decide that is the tenancy model handed away
 * at the front door. So this checks against an invitation somebody with access
 * already wrote, naming both the address and the company.
 *
 * It posts to the same action as signing in, and that is on purpose. The server
 * decides what the address actually is; this screen only sets expectations.
 * Two forms that behaved differently would tell anyone who asked which
 * addresses have accounts and which have been invited.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;
  const next = params.next ?? "/";

  return (
    <AuthCard
      title="Set up your account"
      intro="Enter the address your invitation was sent to. We will email you a six-digit code to confirm it is yours."
      footer="Accounts are created by invitation only, so an address nobody has invited will not receive anything."
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

        <SubmitButton>Email me a code</SubmitButton>
      </form>

      <ol className="mt-6 space-y-2 border-t border-line-soft pt-5 text-sm text-ink-soft">
        <li>
          <strong className="text-ink">1.</strong> We email you a six-digit code
          and you enter it.
        </li>
        <li>
          <strong className="text-ink">2.</strong> You set up an authenticator
          app and save your recovery codes.
        </li>
        <li>
          <strong className="text-ink">3.</strong> From then on you sign in with
          the authenticator — the emailed code stops working for your account,
          so a compromised inbox is not a way in.
        </li>
      </ol>

      <p className="mt-5 text-center text-xs text-ink-faint">
        <Link
          href={`/auth/login?next=${encodeURIComponent(next)}`}
          className="underline underline-offset-2 transition-colors hover:text-ink-soft"
        >
          Already set up? Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
