import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "../../auth-card";

export const metadata: Metadata = { title: "Sign-in could not be completed" };

/**
 * One message for every way the handoff can fail.
 *
 * Expired ticket, already-used ticket, wrong destination, missing or mismatched
 * state — all land here saying the same thing. Distinguishing them would tell
 * anyone probing the flow which of their guesses was closest, and there is
 * nothing a person can usefully do differently in any of those cases anyway.
 */
export default function SsoFailedPage() {
  return (
    <AuthCard
      title="That sign-in link has expired"
      intro="Handoffs between sites are only valid for a few seconds, and only once. Starting again takes a moment."
      footer="If this keeps happening, your browser may be blocking cookies for this site."
    >
      <Link
        href="/"
        className="block w-full rounded-lg bg-brand-surface px-4 py-2.5 text-center
                   text-sm font-semibold text-brand-on-surface transition-colors duration-150
                   hover:bg-brand-surface-hover focus-visible:outline-2
                   focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        Try again
      </Link>
    </AuthCard>
  );
}
