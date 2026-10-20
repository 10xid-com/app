import type { Metadata } from "next";
import { requireSignedIn } from "@/lib/auth/authorize";
import { PASSWORD } from "@/lib/auth/policy";
import { recoveryCodesRemaining, userById } from "@/lib/db/identity";
import { AuthCard, FieldError, SubmitButton, inputClass, labelClass } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { signOutEverywhereAction } from "../../sign-out";
import { regenerateRecoveryCodesAction, removePasswordAction, setPasswordAction } from "../actions";

const ERRORS: Record<string, string> = {
  password_short: `A password needs at least ${PASSWORD.minLength} characters.`,
  password_long: `A password can have at most ${PASSWORD.maxLength} characters.`,
  password_mismatch: "The two passwords are not the same.",
};

const DONE: Record<string, string> = {
  password: "Your password is set. Next time, choose “Sign in with a password”.",
  password_removed: "Your password is removed. Sign in with an emailed code.",
};

export const metadata: Metadata = { title: "Sign-in & security" };

/**
 * The person's own sign-in: a password, how many recovery codes are left, a
 * new set, and signing out everywhere. Nothing from any business.
 *
 * Replacing the authenticator itself is not here: anybody holding a signed-in
 * browser could otherwise swap it for their own. An operator resets it
 * (README, "Lost authenticator"), and the next sign-in sets up a new one.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const ctx = await requireSignedIn("/auth/security");
  const params = await searchParams;
  const [remaining, user] = await Promise.all([recoveryCodesRemaining(ctx.userId), userById(ctx.userId)]);
  const hasPassword = Boolean(user?.passwordHash);
  const error = params.error ? ERRORS[params.error] : null;
  const done = params.done ? DONE[params.done] : null;

  return (
    <AuthCard
      title="Sign-in & security"
      intro={
        <>
          Signed in as <strong className="text-ink">{ctx.email}</strong>. Every sign-in takes a code emailed to you (or
          your password) and then the code from your authenticator app.
        </>
      }
    >
      {done ? <p className="mb-5 rounded-lg border border-line bg-sunk px-3 py-2 text-sm text-ink">{done}</p> : null}
      <section className="mb-6 border-b border-line-soft pb-5">
        <h2 className="text-sm font-semibold text-ink">Password</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {hasPassword
            ? "You have a password. You can sign in with it instead of an emailed code; the authenticator is still asked for."
            : "Set a password to sign in with it instead of an emailed code. The authenticator is still asked for."}
        </p>
        <form action={setPasswordAction} className="mt-3">
          <CsrfField />
          {/* Tells a password manager which account this is for. */}
          <input type="hidden" name="username" autoComplete="username" value={ctx.email} />
          <label htmlFor="password" className={labelClass}>
            {hasPassword ? "New password" : "Password"}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD.minLength}
            maxLength={PASSWORD.maxLength}
            required
            className={inputClass}
          />
          <label htmlFor="confirm" className={`${labelClass} mt-3`}>
            The same again
          </label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD.minLength}
            maxLength={PASSWORD.maxLength}
            required
            className={inputClass}
          />
          {error ? <FieldError>{error}</FieldError> : null}
          <SubmitButton>{hasPassword ? "Change password" : "Set password"}</SubmitButton>
        </form>
        {hasPassword ? (
          <form action={removePasswordAction} className="mt-2 text-center">
            <CsrfField />
            <button type="submit" className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink-soft">
              Remove my password
            </button>
          </form>
        ) : null}
      </section>
      <section>
        <h2 className="text-sm font-semibold text-ink">Recovery codes</h2>
        <p className="mt-1 text-sm text-ink-soft">
          You have <strong className="text-ink">{remaining}</strong> unused {remaining === 1 ? "code" : "codes"}. A new
          set cancels every code in the old one.
        </p>
        <form action={regenerateRecoveryCodesAction}>
          <CsrfField />
          <SubmitButton>Make a new set</SubmitButton>
        </form>
      </section>
      <section className="mt-6 border-t border-line-soft pt-5">
        <h2 className="text-sm font-semibold text-ink">Every device</h2>
        <p className="mt-1 text-sm text-ink-soft">Ends every portal session of this account, this one included.</p>
        <form action={signOutEverywhereAction}>
          <CsrfField />
          <SubmitButton>Sign out everywhere</SubmitButton>
        </form>
      </section>
      <p className="mt-6 text-center text-xs">
        <a href="/dashboard" className="text-ink-faint underline underline-offset-2 hover:text-ink-soft">
          Back to the portal
        </a>
      </p>
    </AuthCard>
  );
}
