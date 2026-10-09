import { publicSocialPhoto } from "@/lib/db/social";

/**
 * A photo waiting to be posted, for Instagram to fetch while the post is made.
 *
 * Public by necessity: Instagram takes a photo only from an address it can
 * fetch without signing in. What protects it is the 256-bit random token in
 * the address, which the portal hands to nobody but the person who uploaded
 * it and Instagram, and stores only as a hash; the photo is deleted once
 * posted, and lasts 24 hours at most. Anything else is a plain 404.
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const bytes = await publicSocialPhoto(token.replace(/\.jpg$/, ""));
  if (!bytes) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(bytes.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
