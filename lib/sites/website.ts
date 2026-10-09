import "server-only";
import { allows } from "@/lib/auth/permissions";
import type { Granted } from "@/lib/auth/authorize";
import type { SiteActor, SiteCan } from "./sign";

/**
 * Who is acting on the website, as the site is told it (./sign.ts).
 *
 * `can` comes from the permission matrix, through the same function every
 * page uses, so it already accounts for agency access: an editor drafts, a
 * publisher, manager or owner publishes, and nobody else reaches the site.
 */
export function siteActorFor(granted: Granted, businessName: string): SiteActor {
  const can: SiteCan[] = [];
  if (allows(granted.role, "pages.edit", granted.via)) can.push("edit");
  if (allows(granted.role, "pages.publish", granted.via)) can.push("publish");
  return {
    email: granted.ctx.email,
    name: granted.ctx.fullName ?? granted.ctx.email,
    role: granted.via ? `${granted.role} (${granted.via.agencyName})` : granted.role,
    business: businessName,
    can,
  };
}

export const POST_STATUSES = ["draft", "published", "scheduled", "archived"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Statuses that put a post on the public site at the next deploy. */
export function isLiveStatus(status: string): boolean {
  return status === "published" || status === "scheduled";
}

/**
 * A Chat Boss draft laid over the site's new-post form (the site's
 * /api/10xid/posts/new/), field by field, so everything the draft does not
 * mention keeps the site's own default — index in search, the default author,
 * the social image. Always a draft.
 */
export function formWithDraft(
  base: Record<string, string | string[]>,
  draft: {
    title: string;
    slug: string;
    excerpt: string;
    meta_description: string;
    seo_title: string;
    focus_keyword: string;
    body_html: string;
    category_ids: number[];
    brand_ids: number[];
    tags: string[];
  },
): Record<string, string | string[]> {
  return {
    ...base,
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt,
    meta_description: draft.meta_description,
    seo_title: draft.seo_title,
    focus_keyword: draft.focus_keyword,
    body_html: draft.body_html,
    term: [...draft.category_ids, ...draft.brand_ids].map(String),
    tag: draft.tags,
    status: "draft",
  };
}
