import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireSignedIn } from "@/lib/auth/authorize";
import { grantSides } from "@/lib/db/agency";
import { PortalShell } from "../../portal-shell";
import { CsrfField } from "../../_components/csrf-field";
import { switchBusinessAction } from "../../business/actions";

export const metadata: Metadata = { title: "Agency access" };

/**
 * The link in an expiry reminder: one grant, opened on the right side.
 *
 * An owner or manager of the business goes to its Team page; one of the
 * agency goes to its Agency page — each at the grant. Only through their own
 * membership: agency access never reaches here. If the session has another
 * business open, it offers to open the right one first (a click, with the
 * CSRF token, never a GET that changes anything). Anybody else gets the same
 * 404 as a grant that does not exist.
 */
export default async function GrantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireSignedIn(`/grants/${id}`);
  if (!z.uuid().safeParse(id).success) notFound();
  const grant = await grantSides(id);
  if (!grant) notFound();

  const manages = (organizationId: string) =>
    ctx.memberships.some((m) => m.organizationId === organizationId && (m.role === "owner" || m.role === "manager"));
  const target = manages(grant.clientId)
    ? { organizationId: grant.clientId, name: grant.clientName, path: `/team#grant-${id}` }
    : manages(grant.agencyId)
      ? { organizationId: grant.agencyId, name: grant.agencyName, path: `/agency#grant-${id}` }
      : null;
  if (!target) notFound();
  if (ctx.scope.organizationId === target.organizationId) redirect(target.path);

  return (
    <PortalShell email={ctx.email} isStaff={false} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Agency access</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-soft">
        This grant is between {grant.agencyName} and {grant.clientName}. Open {target.name} to see it.
      </p>
      <form action={switchBusinessAction} className="mt-4">
        <CsrfField />
        <input type="hidden" name="organizationId" value={target.organizationId} />
        <input type="hidden" name="next" value={target.path} />
        <button
          type="submit"
          className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Open {target.name}
        </button>
      </form>
    </PortalShell>
  );
}
