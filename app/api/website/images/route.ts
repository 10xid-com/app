import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/db/audit";
import { organizationById } from "@/lib/db/identity";
import { websiteFor } from "@/lib/db/sites";
import { SiteError, siteRequest } from "@/lib/sites/client";
import { siteActorFor } from "@/lib/sites/website";

/**
 * An image for a blog post, from the Website channel's editor, passed to the
 * business's own site to store (the site's /api/admin/media/upload).
 *
 * pages.edit on the business the session has open, CSRF and Origin checked
 * by the central function like every write. The site is the business's own
 * connection, never one the request names, and the request is signed as the
 * person (lib/sites/), so the site's own checks — size, the image type, the
 * bytes themselves — apply to them as they do in its own admin.
 *
 * A route rather than a server action: actions are capped at 1MB, and raising
 * that would raise it for every form in the app.
 */

export const dynamic = "force-dynamic";

/** Under Next's 10MB proxy body limit, with room for the multipart wrapping. */
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

export async function POST(request: Request) {
  const decision = await authorizeRequest(request, "pages.edit");
  if (!decision.allowed) return NextResponse.json({ error: "Your role cannot add images here." }, { status: 403 });
  const owner = { organizationId: decision.businessId, userId: decision.ctx.userId };
  const site = await websiteFor(owner);
  if (!site) return NextResponse.json({ error: "Connect the website first." }, { status: 409 });

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "The image did not arrive. Try again." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose an image." }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That image is ${(file.size / 1048576).toFixed(1)}MB. The limit is 8MB; a smaller export will do.` },
      { status: 413 },
    );
  }
  if (!TYPES.has(file.type)) {
    return NextResponse.json({ error: "Only JPEG, PNG, GIF, WebP and AVIF images can be added." }, { status: 415 });
  }

  const business = await organizationById(decision.businessId);
  const upload = new FormData();
  upload.set("file", file, file.name || "image");
  let result: { status: number; body: Record<string, unknown> };
  try {
    result = await siteRequest({
      siteUrl: site.siteUrl,
      actor: siteActorFor(decision, business?.name ?? ""),
      method: "POST",
      path: "/api/admin/media/upload/",
      multipart: upload,
    });
  } catch (err) {
    if (!(err instanceof SiteError)) throw err;
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
  const path = typeof result.body.path === "string" ? result.body.path : null;
  const url = typeof result.body.url === "string" ? result.body.url : null;
  if (result.status !== 200 || !path || !url) {
    const error = typeof result.body.error === "string" ? result.body.error : `The site answered ${result.status}.`;
    return NextResponse.json({ error }, { status: result.status >= 400 ? result.status : 502 });
  }

  await recordAudit([
    {
      organizationId: decision.businessId,
      actorUserId: decision.ctx.userId,
      agencyGrantId: decision.via?.grantId ?? null,
      action: "site.image_uploaded",
      target: `${site.siteUrl}${path}`,
    },
  ]);
  return NextResponse.json({ path, url }, { headers: { "Cache-Control": "no-store" } });
}
