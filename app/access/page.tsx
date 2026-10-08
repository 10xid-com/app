import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveIdentity } from "@/lib/auth/session";
import { signInPath } from "@/lib/auth/authorize";
import { AuthCard, SubmitButton } from "../_components/auth-card";
import { CsrfField } from "../_components/csrf-field";
import { signOutAction } from "../sign-out";

export const metadata: Metadata = { title: "Access" };

/**
 * Where a signed-in person lands when the portal has nothing to show them,
 * told plainly why. (Somebody signed in on the login host but not yet tied to
 * an account never gets this far: the login host's own /auth/access page
 * explains that, and no handoff happens.)
 *
 * Read-only. It is the one signed-in page that does not go through the
 * central authorization function, because its whole job is to describe the
 * answer that function gave; it shows the person's own state and nothing from
 * any business.
 */

const DENIED: Record<string, { title: string; intro: string }> = {
  no_business: {
    title: "No business selected",
    intro:
      "Your account isn't attached to a business yet, so there is nothing to open. Ask an owner of the business to invite this address.",
  },
  not_a_member: {
    title: "You're not a member of this business",
    intro: "Ask an owner of the business to invite you.",
  },
  business_unavailable: {
    title: "This business isn't available",
    intro: "It may have been closed. Ask its owner if you think this is a mistake.",
  },
  role_lacks_action: {
    title: "Your role doesn't include this",
    intro:
      "Your role in this business doesn't allow it. If you need it, ask an owner or a manager of the business to change your role.",
  },
  stale_authenticator: {
    title: "Confirm it is you",
    intro:
      "This needs a recent code from your authenticator app: within the last day for agency access, within five minutes to approve it. Sign in again to continue.",
  },
  staff_access_off: {
    title: "Staff access is turned off",
    intro:
      "10XiD staff no longer reach client businesses directly. This will return as access each client approves.",
  },
};

export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const identity = await resolveIdentity();
  if (identity.state === "signed_out") redirect(signInPath("/"));

  const { reason } = await searchParams;

  const denied = reason ? DENIED[reason] : undefined;
  if (!denied) redirect("/dashboard");
  const { title, intro } = denied;

  return (
    <AuthCard title={title} intro={intro}>
      <form action={signOutAction}>
        <CsrfField />
        <SubmitButton>Sign out</SubmitButton>
      </form>
    </AuthCard>
  );
}
