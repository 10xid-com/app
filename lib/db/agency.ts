import "server-only";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "./connection";
import { agencyGrantPeople, agencyGrants, memberships, organizations } from "./schema";

/**
 * Agency access a person holds right now — read, like memberships, before any
 * scope exists, because it is one of the things that PRODUCES the scope.
 *
 * Live means all of these, checked on every request:
 *   * the grant is in force (approved, not revoked) and its date has not come;
 *   * this person is on it and approved — not requested, blocked or removed;
 *   * they are still a member of the agency, and the agency is still an
 *     agency and not deleted;
 *   * the business is a live client business.
 *
 * Drop any one and the business is off their screen on the next click. The
 * rules about who may change any of this are the database's (login's 0025).
 */
export type AgencyAccess = {
  grantId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  agencyOrganizationId: string;
  agencyName: string;
  role: string;
  expiresAt: Date;
};

const client = alias(organizations, "client");
const agency = alias(organizations, "agency");

export async function liveAgencyAccessFor(userId: string): Promise<AgencyAccess[]> {
  const rows = await db
    .select({
      grantId: agencyGrants.id,
      organizationId: client.id,
      organizationName: client.name,
      organizationSlug: client.slug,
      agencyOrganizationId: agency.id,
      agencyName: agency.name,
      role: agencyGrants.role,
      expiresAt: agencyGrants.expiresAt,
    })
    .from(agencyGrantPeople)
    .innerJoin(agencyGrants, eq(agencyGrants.id, agencyGrantPeople.grantId))
    .innerJoin(client, eq(client.id, agencyGrants.clientOrganizationId))
    .innerJoin(agency, eq(agency.id, agencyGrants.agencyOrganizationId))
    .innerJoin(
      memberships,
      and(eq(memberships.organizationId, agency.id), eq(memberships.userId, agencyGrantPeople.userId)),
    )
    .where(
      and(
        eq(agencyGrantPeople.userId, userId),
        eq(agencyGrantPeople.status, "approved"),
        eq(agencyGrants.status, "active"),
        gt(agencyGrants.expiresAt, sql`now()`),
        eq(client.type, "client"),
        isNull(client.deletedAt),
        eq(agency.isAgency, true),
        isNull(agency.deletedAt),
        inArray(memberships.role, ["owner", "manager", "editor", "publisher", "asset_manager", "viewer"]),
      ),
    );
  return rows.map((r) => ({ ...r, expiresAt: r.expiresAt! }));
}
