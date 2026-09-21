import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { refuseWhileActingAs } from "@/lib/auth/require";
import { recoveryCodesRemaining, userById } from "@/lib/db/identity";
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_FLASH_COOKIE,
} from "@/lib/auth/recovery";
import { AuthCard, SubmitButton } from "../auth-card";
import {
  acknowledgeRecoveryCodesAction,
  regenerateRecoveryCodesAction,
} from "../2fa/actions";

export const metadata: Metadata = { title: "Recovery codes" };

/**
 * The codes, shown once.
 *
 * They exist because of a specific consequence of signing in with an
 * authenticator: the emailed code no longer opens this account, so a lost or
 * wiped phone would otherwise lock it permanently.
 *
 * Only hashes are stored, so this screen cannot re-render them later — it reads
 * them from the one-hop carrier the action set, and once that is acknowledged
 * they are gone for good. That is the property that makes them worth anything.
 */
export default async function RecoveryCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");
  // The screen that shows recovery codes, shown to somebody who is not the
  // account holder, is the account handed over. Refused for the duration.
  refuseWhileActingAs(ctx);

  const user = await userById(ctx.userId);
  if (!user?.totpConfirmedAt) redirect("/auth/2fa");

  const params = await searchParams;
  const next = params.next ?? "/dashboard";

  const jar = await cookies();
  const codes = (jar.get(RECOVERY_FLASH_COOKIE)?.value ?? "")
    .split(" ")
    .filter(Boolean);

  // Arrived here without a freshly issued set — a reload after acknowledging,
  // or a bookmark. Nothing can be shown, and saying so plainly is better than
  // an empty screen that looks broken.
  if (codes.length === 0) {
    const remaining = await recoveryCodesRemaining(ctx.userId);
    return (
      <AuthCard
        title="Recovery codes"
        intro={
          <>
            Your codes are stored only as hashes, so they cannot be shown again.
            You have <strong className="text-ink">{remaining}</strong> unused{" "}
            {remaining === 1 ? "code" : "codes"} left.
          </>
        }
        footer="Generating a new set immediately cancels every code in the old one."
      >
        <form action={regenerateRecoveryCodesAction}>
          <input type="hidden" name="next" value={next} />
          <SubmitButton>Generate a new set</SubmitButton>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Save your recovery codes"
      intro={
        <>
          These are how you get back in if you lose your authenticator. Signing
          in by emailed code no longer works for this account, so without one of
          these there is no other way. Each works once.
        </>
      }
      footer="Print them, or put them in a password manager — not on the phone holding your authenticator."
    >
      <ul className="mb-5 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-sunk p-4">
        {codes.map((code) => (
          <li
            key={code}
            className="font-mono text-sm tracking-wide text-ink select-all"
          >
            {code}
          </li>
        ))}
      </ul>

      <p className="mb-4 text-xs text-ink-faint">
        {codes.length} of {RECOVERY_CODE_COUNT} codes. This screen will not show
        them again.
      </p>

      <form action={acknowledgeRecoveryCodesAction}>
        <input type="hidden" name="next" value={next} />
        <SubmitButton>I have saved these — continue</SubmitButton>
      </form>
    </AuthCard>
  );
}
