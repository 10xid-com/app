import type { Metadata } from "next";
import { requireSignedIn } from "@/lib/auth/authorize";
import { recoveryCodesRemaining } from "@/lib/db/identity";
import { AuthCard, SubmitButton } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { signOutEverywhereAction } from "../../sign-out";
import { regenerateRecoveryCodesAction } from "../actions";

export const metadata: Metadata = { title: "Sign-in & security" };

/**
 * The person's own sign-in: how many recovery codes are left, a new set, and
 * signing out everywhere. Nothing from any business.
 *
 * Replacing the authenticator itself is not here: anybody holding a signed-in
 * browser could otherwise swap it for their own. An operator resets it
 * (README, "Lost authenticator"), and the next sign-in sets up a new one.
 */
export default async function SecurityPage() {
  const ctx = await requireSignedIn("/auth/security");
  const remaining = await recoveryCodesRemaining(ctx.userId);

  return (
    <AuthCard
      title="Sign-in & security"
      intro={
        <>
          Signed in as <strong className="text-ink">{ctx.email}</strong>. Every sign-in takes a code emailed to you and
          then the code from your authenticator app.
        </>
      }
    >
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
