import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveIdentity } from "@/lib/auth/session";
import { signInPath } from "@/lib/auth/authorize";
import { AuthCard, SubmitButton } from "../_components/auth-card";
import { CsrfField } from "../_components/csrf-field";
import { signOutAction } from "../sign-out";

export const metadata: Metadata = { title: "Access" };

/**
 * Where somebody signed in to WorkOS lands when the portal has nothing to
 * show them, told plainly why.
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
      "Your account isn't attached to exactly one business, so there is nothing to open yet. If you work with several businesses, choosing between them isn't available yet.",
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
    title: "Your role doesn't include this yet",
    intro:
      "Only owners have permissions at the moment. The other roles are being set up and will get theirs soon.",
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
  let title: string;
  let intro: string;

  if (identity.state === "impersonated") {
    title = "Impersonation isn't available";
    intro = "Signing in as somebody else is turned off for the 10XiD portal.";
  } else if (identity.state === "unbound") {
    if (!identity.emailVerified) {
      title = "Verify your email address";
      intro = "Your address hasn't been verified yet. Sign out, then sign in again and follow the verification step.";
    } else if (identity.pendingBinding) {
      title = "We're confirming it's you";
      intro = `You already have a 10XiD account at ${identity.email}. Before the new sign-in can open it, someone at 10XiD will confirm it's really you. You'll be able to continue once that's done.`;
    } else {
      title = "This sign-in doesn't have access yet";
      intro = `There's no invitation for ${identity.email}. Ask the owner of the business you work with to invite this exact address.`;
    }
  } else {
    const denied = reason ? DENIED[reason] : undefined;
    if (!denied) redirect("/dashboard");
    ({ title, intro } = denied);
  }

  return (
    <AuthCard title={title} intro={intro}>
      <form action={signOutAction}>
        <CsrfField />
        <SubmitButton>Sign out</SubmitButton>
      </form>
    </AuthCard>
  );
}
