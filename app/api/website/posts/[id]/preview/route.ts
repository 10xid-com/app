import { authorizeRequest } from "@/lib/auth/authorize";
import { organizationById } from "@/lib/db/identity";
import { websiteFor } from "@/lib/db/sites";
import { SiteError, sitePage } from "@/lib/sites/client";
import { siteActorFor } from "@/lib/sites/website";

/**
 * "Preview on site": a saved post, drawn by the business's own site exactly as
 * its next build will draw it, at any status — a draft included, without
 * publishing anything.
 *
 * pages.edit on the business the session has open. The site is the business's
 * own connection, and the request is signed as the person (lib/sites/), so the
 * site decides what they may see, as for every other call.
 *
 * The page is the site's HTML, served from the portal's address, so it goes
 * out sandboxed: `sandbox` in its CSP gives it an opaque origin and no
 * scripts, whether it is opened in the editor's frame or on its own, so
 * nothing in a post can reach the portal or the person's session. A <base>
 * pointing at the site makes its stylesheets, fonts, images and links resolve
 * there.
 */

export const dynamic = "force-dynamic";

function headersFor(siteOrigin: string | null): Headers {
  const self = siteOrigin ?? "'none'";
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "sandbox allow-popups allow-popups-to-escape-sandbox",
      "default-src 'none'",
      `style-src ${self} 'unsafe-inline'`,
      `font-src ${self} data:`,
      "img-src https: data:",
      "media-src https:",
      // Video a post embeds (YouTube, Vimeo).
      "frame-src https:",
      `base-uri ${self}`,
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  });
}

function message(text: string, status: number): Response {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Preview</title><p style="font:14px/1.5 system-ui,sans-serif;color:#444;padding:24px">${safe}</p>`,
    { status, headers: headersFor(null) },
  );
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, "pages.edit");
  if (!decision.allowed) return message("Your role cannot preview posts here.", 403);
  const { id } = await ctx.params;
  if (!/^\d{1,9}$/.test(id)) return message("Save the post first, then preview it.", 404);
  const site = await websiteFor({ organizationId: decision.businessId, userId: decision.ctx.userId });
  if (!site) return message("Connect the website first.", 409);

  const business = await organizationById(decision.businessId);
  let page: Awaited<ReturnType<typeof sitePage>>;
  try {
    page = await sitePage({
      siteUrl: site.siteUrl,
      actor: siteActorFor(decision, business?.name ?? ""),
      path: `/api/10xid/posts/${id}/preview/`,
    });
  } catch (err) {
    if (!(err instanceof SiteError)) throw err;
    return message(`The site did not answer: ${err.message}`, 502);
  }
  if (page.status === 404) return message("The site has no preview for this post yet, or the post no longer exists.", 404);
  if (page.status !== 200 || page.html === null) return message(`The site answered ${page.status}.`, 502);

  // Resolve the page's relative addresses against the site, not the portal.
  const base = `<base href="${page.origin}/">`;
  const html = /<head[^>]*>/i.test(page.html)
    ? page.html.replace(/<head[^>]*>/i, (head) => `${head}${base}`)
    : `${base}${page.html}`;
  return new Response(html, { status: 200, headers: headersFor(page.origin) });
}
