import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { requireSignedIn } from "@/lib/auth/authorize";
import { safePath } from "@/lib/auth/paths";
import { RECOVERY_CODE_COUNT, RECOVERY_FLASH_COOKIE } from "@/lib/auth/recovery";
import { AuthCard, SubmitButton } from "../../_components/auth-card";
import { CsrfField } from "../../_components/csrf-field";
import { acknowledgeRecoveryCodesAction } from "../actions";

export const metadata: Metadata = { title: "Recovery codes" };

/**
 * The codes, shown once. Only hashes are stored, so this screen reads them
 * from the one-hop carrier the action set; once acknowledged they are gone.
 */
export default async function RecoveryCodesPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const next = safePath(params.next);
  await requireSignedIn(`/auth/recovery-codes?next=${encodeURIComponent(next)}`);

  const codes = ((await cookies()).get(RECOVERY_FLASH_COOKIE)?.value ?? "").split(" ").filter(Boolean);

  // A reload after acknowledging, or a bookmark: nothing can be shown, and
  // saying so is better than an empty screen that looks broken.
  if (codes.length === 0) {
    return (
      <AuthCard
        title="Recovery codes"
        intro="Your codes are stored only as hashes, so they cannot be shown again. You can make a new set on the security page."
      >
        <Link href="/auth/security" className="text-sm font-medium text-brand underline underline-offset-2">
          Sign-in &amp; security
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Save your recovery codes"
      intro="These get you in if you lose your authenticator. Each works once, in place of the authenticator code."
      footer="Print them, or put them in a password manager — not on the phone holding your authenticator."
    >
      <ul className="mb-5 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-sunk p-4">
        {codes.map((code) => (
          <li key={code} className="font-mono text-sm tracking-wide text-ink select-all">
            {code}
          </li>
        ))}
      </ul>
      <p className="mb-4 text-xs text-ink-faint">
        {codes.length} of {RECOVERY_CODE_COUNT} codes. This screen will not show them again.
      </p>
      <form action={acknowledgeRecoveryCodesAction}>
        <CsrfField />
        <input type="hidden" name="next" value={next} />
        <SubmitButton>I have saved these — continue</SubmitButton>
      </form>
    </AuthCard>
  );
}
