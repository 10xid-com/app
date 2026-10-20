import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safePath } from "@/lib/auth/paths";
import { resolveIdentity } from "@/lib/auth/session";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { requestCodeAction } from "../actions";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  email: "That does not look like an email address. Check it and try again.",
  rate: "Too many codes requested for that address. Wait a few minutes and try again.",
};

const NOTICES: Record<string, string> = {
  "signed-out": "You are signed out.",
  "signed-out-everywhere": "You are signed out on every device.",
};

/**
 * Signing in, and accepting an invitation: the same screen. It says the same
 * thing whatever address is typed, so it cannot be used to discover who has
 * an account or an invitation.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; email?: string; notice?: string }>;
}) {
  const params = await searchParams;
  const next = safePath(params.next);

  const identity = await resolveIdentity();
  if (identity.state === "active") redirect(next);
  if (identity.state === "pending") redirect(`/auth/authenticator?next=${encodeURIComponent(next)}`);

  const error = params.error ? ERRORS[params.error] : null;
  const notice = params.notice ? NOTICES[params.notice] : null;

  return (
    <AuthCard
      title="Sign in"
      intro="Enter your email and we will send you a six-digit code. Then you will be asked for the code from your authenticator app."
      footer="Invited to a business? Sign in here with the address the invitation went to."
    >
      {notice ? <p className="mb-4 text-sm text-ink-soft">{notice}</p> : null}
      <form action={requestCodeAction}>
        <CsrfField />
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
          autoFocus
          defaultValue={params.email ?? ""}
          placeholder="you@company.com"
          className={inputClass}
        />
        {error ? <FieldError>{error}</FieldError> : null}
        <SubmitButton>Email me a code</SubmitButton>
      </form>
    </AuthCard>
  );
}
