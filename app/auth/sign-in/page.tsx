import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { safePath } from "@/lib/auth/paths";
import { resolveIdentity } from "@/lib/auth/session";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { passwordSignInAction, requestCodeAction } from "../actions";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  email: "That does not look like an email address. Check it and try again.",
  rate: "Too many codes requested for that address. Wait a few minutes and try again.",
  password: "That email and password don't match. Try again, or sign in with an emailed code.",
  password_rate: "Too many tries for that address. Wait fifteen minutes, or sign in with an emailed code.",
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
  searchParams: Promise<{ error?: string; next?: string; email?: string; notice?: string; method?: string }>;
}) {
  const params = await searchParams;
  const next = safePath(params.next);

  const identity = await resolveIdentity();
  if (identity.state === "active") redirect(next);
  if (identity.state === "pending") redirect(`/auth/authenticator?next=${encodeURIComponent(next)}`);

  const error = params.error ? ERRORS[params.error] : null;
  const notice = params.notice ? NOTICES[params.notice] : null;

  const switchTo = (method: "code" | "password") =>
    `/auth/sign-in?${new URLSearchParams({ next, ...(params.email ? { email: params.email } : {}), ...(method === "password" ? { method } : {}) })}`;

  if (params.method === "password") {
    return (
      <AuthCard
        title="Sign in"
        intro="Enter your email and your 10XiD portal password. Then you will be asked for the code from your authenticator app."
        footer="No password yet? Sign in with an emailed code, then set one under Sign-in & security."
      >
        {notice ? <p className="mb-4 text-sm text-ink-soft">{notice}</p> : null}
        <form action={passwordSignInAction}>
          <CsrfField />
          <input type="hidden" name="next" value={next} />
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus={!params.email}
            defaultValue={params.email ?? ""}
            placeholder="you@company.com"
            className={inputClass}
          />
          <label htmlFor="password" className={`${labelClass} mt-4`}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus={!!params.email}
            className={inputClass}
          />
          {error ? <FieldError>{error}</FieldError> : null}
          <SubmitButton>Continue</SubmitButton>
        </form>
        <p className="mt-4 text-center text-xs text-ink-faint">
          <Link href={switchTo("code")} className="underline underline-offset-2 transition-colors hover:text-ink-soft">
            Email me a code instead
          </Link>
        </p>
      </AuthCard>
    );
  }

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
      <p className="mt-4 text-center text-xs text-ink-faint">
        <Link href={switchTo("password")} className="underline underline-offset-2 transition-colors hover:text-ink-soft">
          Sign in with a password instead
        </Link>
      </p>
    </AuthCard>
  );
}
