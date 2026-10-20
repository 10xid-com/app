import 'server-only';
import { integrationConfig } from './integration-config';
import { issuePurchaseAssertion } from './assertion';
export type OutlinePurchase = { entitlement_id: string; product_name: string; purchased_at: string; purchase_reference: string; asset_id: string | null; sha256: string | null; library_url: string };
export async function wrapAuthorityPurchases(userId: string, sessionId: string): Promise<{ available: boolean; items: OutlinePurchase[] }> {
  const config = integrationConfig();
  if (!config) return { available: false, items: [] };
  try {
    const response = await fetch(config.waOrigin + '/api/wrapauthority/10xid/purchases', {
      method: 'POST', headers: { Authorization: 'Bearer ' + issuePurchaseAssertion(userId, sessionId) },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { available: false, items: [] };
    const body = await response.json();
    if (!Array.isArray(body.items) || body.items.length > 1000) return { available: false, items: [] };
    const items: OutlinePurchase[] = body.items.map((row: OutlinePurchase) => {
      if (typeof row.entitlement_id !== 'string' || typeof row.product_name !== 'string' ||
          typeof row.purchased_at !== 'string' || typeof row.purchase_reference !== 'string' ||
          row.library_url !== config.waOrigin + '/wrapauthority/my-outlines') throw new Error('invalid_purchase_response');
      return { entitlement_id: row.entitlement_id, product_name: row.product_name, purchased_at: row.purchased_at,
        purchase_reference: row.purchase_reference, asset_id: row.asset_id, sha256: row.sha256, library_url: row.library_url };
    });
    return { available: true, items };
  } catch { return { available: false, items: [] }; }
}
