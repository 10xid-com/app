import Link from 'next/link';
import { requireSignedIn } from '@/lib/auth/authorize';
import { wrapAuthorityPurchases } from '@/lib/wrapauthority/purchases';
import { integrationConfig } from '@/lib/wrapauthority/integration-config';
import { PortalShell } from '../portal-shell';
export const dynamic = 'force-dynamic';
export default async function WrapAuthorityPurchasesPage() {
  const ctx = await requireSignedIn('/wrapauthority');
  const result = await wrapAuthorityPurchases(ctx.userId, ctx.sessionId);
  const config = integrationConfig();
  return <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
    <h1 className="text-2xl font-semibold">Your Wrap Authority outlines</h1>
    <p className="mt-2 text-ink-soft">Your purchases are held by Wrap Authority. Open your library there to download the original artwork.</p>
    {!result.available ? <p role="status" className="mt-6">Your purchase library is temporarily unavailable. Please try again.</p> :
      result.items.length === 0 ? <p className="mt-6">No purchases are available for this linked account. If you already bought outlines, sign in to Wrap Authority and link your verified 10XiD account.</p> :
      <ul className="mt-6 space-y-4">{result.items.map(item => <li key={item.entitlement_id} className="rounded-xl border border-line p-5">
        <h2 className="font-semibold">{item.product_name}</h2>
        <p className="mt-1 text-sm">Purchased {new Date(item.purchased_at).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })}</p>
        <p className="text-sm">Reference: {item.purchase_reference}</p>
        <a className="mt-3 inline-block underline" href={item.library_url}>Open in Wrap Authority</a>
      </li>)}</ul>}
    {config && <p className="mt-6"><a className="underline" href={config.waOrigin + '/wrapauthority/my-outlines'}>Open Wrap Authority library</a></p>}
    <p className="mt-6"><Link href="/dashboard">Back to dashboard</Link></p>
  </PortalShell>;
}
