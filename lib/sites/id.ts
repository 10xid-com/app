/**
 * Which business has a live iD, and where it is.
 *
 * An iD is built and served by 10xid-com/10xid-id-preview: the card itself at
 * `https://preview.10xid.com/id/<slug>/`, and once the business launches it,
 * at its own address, `https://<slug>.10xid.com/`. Nothing in this database
 * records that yet, so for now it is one setting, ID_PREVIEWS, naming each
 * business by its slug and the iD it has:
 *
 *   ID_PREVIEWS=vinyl-wrap-toronto:vwt,route-401:route401
 *
 * Unset, or for a business it does not name, the iD page keeps its drawing.
 * The value is checked here rather than trusted: an iD slug becomes part of a
 * hostname and a path, so anything but lowercase letters, digits and hyphens
 * is dropped.
 */

const PREVIEW_ORIGIN = "https://preview.10xid.com";
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface LiveId {
  /** The iD's own slug, e.g. `vwt`. */
  slug: string;
  /** The card as it is built today, for the preview frame. */
  previewUrl: string;
  /** Its own address, e.g. `vwt.10xid.com`, without the scheme. */
  address: string;
  /** What Launch iD opens. */
  launchUrl: string;
}

export function parseIdPreviews(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const [business, id] = pair.split(":").map((s) => s.trim().toLowerCase());
    if (!business || !id || !SLUG.test(id)) continue;
    out.set(business, id);
  }
  return out;
}

export function liveIdFor(businessSlug: string, value = process.env.ID_PREVIEWS): LiveId | null {
  const slug = parseIdPreviews(value).get(businessSlug.toLowerCase());
  if (!slug) return null;
  const address = `${slug}.10xid.com`;
  return {
    slug,
    previewUrl: `${PREVIEW_ORIGIN}/id/${slug}/`,
    address,
    launchUrl: `https://${address}/`,
  };
}
