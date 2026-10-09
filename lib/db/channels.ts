import "server-only";
import { isNull } from "drizzle-orm";
import { inOwnerTransaction } from "./connection";
import { siteConnections, socialConnections } from "./schema";

/**
 * Which channels a business has connected: its website (0028) and its social
 * accounts (0034). For the sidebar, which lists only those, and the Channels
 * page, which offers the rest. One transaction, under the business's own
 * row-level security, so another business's connections are not there.
 */

export type ConnectedChannel = "website" | "instagram" | "facebook";

export async function connectedChannels(owner: { organizationId: string; userId: string }): Promise<Set<ConnectedChannel>> {
  const [sites, social] = await inOwnerTransaction(owner.organizationId, owner.userId, (tx) =>
    Promise.all([
      tx.select({ channel: siteConnections.channel }).from(siteConnections).where(isNull(siteConnections.disconnectedAt)),
      tx.select({ channel: socialConnections.channel }).from(socialConnections).where(isNull(socialConnections.disconnectedAt)),
    ]),
  );
  const out = new Set<ConnectedChannel>();
  if (sites.some((s) => s.channel === "website")) out.add("website");
  for (const s of social) out.add(s.channel);
  return out;
}
