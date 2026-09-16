import type { Metadata } from "next";
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

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <AuthCard
      title="Welcome back"
      intro="Enter your email and we'll send you a six-digit code. No password to remember."
      footer="Accounts are set up by Branding Centres. If you don't have one yet, ask your contact there."
    >
      <form action={requestCodeAction}>
        <input type="hidden" name="next" value={params.next ?? "/"} />

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

        <SubmitButton>Send me a code</SubmitButton>
      </form>
    </AuthCard>
  );
}
