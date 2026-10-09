"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAction } from "@/lib/auth/authorize";
import { CSRF_FIELD } from "@/lib/auth/csrf-names";
import { organizationById } from "@/lib/db/identity";
import { recordAudit } from "@/lib/db/audit";
import { AlreadyLinkedError, linkRepository, listLinkedRepositories } from "@/lib/db/repositories";
import { SiteTakenError, connectWebsite, disconnectWebsite, setWebsiteRepository, websiteFor } from "@/lib/db/sites";
import { githubApp } from "@/lib/repo";
import { RepoError } from "@/lib/repo/types";
import { SiteError, siteOriginFrom, siteRequest } from "@/lib/sites/client";
import { formWithDraft, isLiveStatus, siteActorFor } from "@/lib/sites/website";
import { getBlogDraftReceipt } from "@/lib/db/workspace";
import { blogDraftSchema } from "@/lib/workspace/blog-tools";

/**
 * The Website channel's writes. Each passes the central authorization
 * function first (Origin, CSRF, membership or agency grant, role), and
 * nothing in a form names a business or a site: both come from the session
 * and the business's own live connection.
 *
 *   connect, disconnect   domains.manage — owners only, never through an agency
 *   website's repository  domains.manage
 *   save a post           pages.edit — and pages.publish for anything live
 *   publish               pages.publish
 */

const BACK = "/channels/website";

export async function connectWebsiteAction(formData: FormData) {
  const granted = await requireAction("domains.manage", formData, { returnPath: BACK });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };

  const siteUrl = siteOriginFrom(String(formData.get("siteUrl") ?? ""));
  if (!siteUrl) redirect(`${BACK}?error=url`);

  // The repository is optional, and only one linked to this business counts.
  const repoId = String(formData.get("repositoryId") ?? "");
  const repositoryId = repoId
    ? ((await listLinkedRepositories(owner)).find((r) => r.id === repoId)?.id ?? null)
    : null;
  if (repoId && !repositoryId) redirect(`${BACK}?error=repo`);

  if (await websiteFor(owner)) redirect(`${BACK}?error=connected`);
  try {
    await connectWebsite(owner, { siteUrl, repositoryId, agencyGrantId: granted.via?.grantId ?? null });
  } catch (err) {
    if (err instanceof SiteTakenError) redirect(`${BACK}?error=taken`);
    throw err;
  }
  redirect(`${BACK}?done=connected`);
}

export async function disconnectWebsiteAction(formData: FormData) {
  const granted = await requireAction("domains.manage", formData, { returnPath: BACK });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const id = z.uuid().parse(formData.get("connectionId"));
  await disconnectWebsite(owner, id, granted.via?.grantId ?? null);
  redirect(`${BACK}?done=disconnected`);
}

/**
 * Attach the GitHub repository the website is built from, change it, or take
 * it off — without disconnecting the site. The form names one choice:
 *
 *   linked:<id>     a repository already linked to this business
 *   github:<id>     one the GitHub App can see, by GitHub's id; it is linked to
 *                   this business first, from GitHub's own answer (owner, name,
 *                   installation), never from the form
 *   none            no repository
 *
 * A repository linked to another business cannot be linked here; the
 * database refuses it and the page says so.
 */
export async function setWebsiteRepositoryAction(formData: FormData) {
  const granted = await requireAction("domains.manage", formData, { returnPath: BACK });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const grant = granted.via?.grantId ?? null;
  const site = await websiteFor(owner);
  if (!site) redirect(`${BACK}?error=notconnected`);

  const choice = String(formData.get("repository") ?? "");
  let repositoryId: string | null = null;
  let label = "none";

  if (choice.startsWith("linked:")) {
    const row = (await listLinkedRepositories(owner)).find((r) => r.id === choice.slice(7));
    if (!row) redirect(`${BACK}?error=repo`);
    repositoryId = row.id;
    label = `${row.owner}/${row.name}`;
  } else if (choice.startsWith("github:")) {
    const externalId = Number(choice.slice(7));
    const app = githubApp();
    if (!app || !Number.isSafeInteger(externalId) || externalId <= 0) redirect(`${BACK}?error=repo`);
    // Picked from a list read a moment ago: it may have been linked here since.
    const already = (await listLinkedRepositories(owner)).find((r) => r.externalId === externalId);
    if (already) {
      repositoryId = already.id;
      label = `${already.owner}/${already.name}`;
    } else {
      let found;
      try {
        found = await app.findAccessibleRepository(externalId);
      } catch (err) {
        if (!(err instanceof RepoError)) throw err;
        redirect(`${BACK}?error=github`);
      }
      if (!found) redirect(`${BACK}?error=repo`);
      try {
        const row = await linkRepository(owner, found);
        repositoryId = row.id;
        label = `${row.owner}/${row.name}`;
      } catch (err) {
        if (err instanceof AlreadyLinkedError) redirect(`${BACK}?error=elsewhere`);
        throw err;
      }
    }
  } else if (choice !== "none") {
    redirect(`${BACK}?error=repo`);
  }

  await setWebsiteRepository(owner, { connectionId: site.id, repositoryId, label, agencyGrantId: grant });
  redirect(`${BACK}?done=${repositoryId ? "repo" : "norepo"}`);
}

/**
 * Save a post through the site's own save route, which sanitises the body,
 * recomputes the SEO score, keeps a revision and records who saved it. The
 * editor sends back every field the site gave it (see the site's
 * /api/10xid/posts/[id]), so passing the form through unchanged, less the
 * CSRF token, is what keeps fields the screen does not show from being
 * cleared.
 */
export async function savePostAction(formData: FormData) {
  const granted = await requireAction("pages.edit", formData, { returnPath: `${BACK}/posts` });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const site = await websiteFor(owner);
  if (!site) redirect(`${BACK}?error=notconnected`);

  const id = String(formData.get("id") ?? "");
  const back = `${BACK}/posts/${/^\d+$/.test(id) ? id : "new"}`;

  const business = await organizationById(granted.businessId);
  const actor = siteActorFor(granted, business?.name ?? "");
  const status = String(formData.get("status") ?? "");
  // The site refuses this too; saying so here keeps the message ours.
  if (isLiveStatus(status) && !actor.can.includes("publish")) redirect(`${back}?error=publish`);

  const form: Record<string, string[]> = {};
  for (const [key, value] of formData.entries()) {
    if (key === CSRF_FIELD || key === "tags_csv" || key.startsWith("$ACTION") || typeof value !== "string") continue;
    (form[key] ??= []).push(value);
  }
  // Tags are typed as one comma-separated line; the site reads one field each.
  form.tag = String(formData.get("tags_csv") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 40);

  let result: { status: number; body: Record<string, unknown> };
  try {
    result = await siteRequest({ siteUrl: site.siteUrl, actor, method: "POST", path: "/api/admin/posts/save/", form });
  } catch (err) {
    if (err instanceof SiteError) redirect(`${back}?error=site&detail=${encodeURIComponent(err.message.slice(0, 200))}`);
    throw err;
  }
  if (result.status !== 200 || typeof result.body.id !== "number") {
    const detail = typeof result.body.error === "string" ? result.body.error : `The site answered ${result.status}.`;
    redirect(`${back}?error=site&detail=${encodeURIComponent(detail.slice(0, 300))}`);
  }

  await recordAudit([
    {
      organizationId: granted.businessId,
      actorUserId: granted.ctx.userId,
      agencyGrantId: granted.via?.grantId ?? null,
      action: "site.post.saved",
      target: `${String(formData.get("title") ?? "").slice(0, 120)} (${status})`,
    },
  ]);
  redirect(`${BACK}/posts/${result.body.id}?done=saved`);
}

/** Rebuild and deploy the site from what is saved, through the site's own deploy. */
export async function publishWebsiteAction(formData: FormData) {
  const granted = await requireAction("pages.publish", formData, { returnPath: BACK });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const site = await websiteFor(owner);
  if (!site) redirect(`${BACK}?error=notconnected`);
  const business = await organizationById(granted.businessId);

  let result: { status: number; body: Record<string, unknown> };
  try {
    result = await siteRequest({
      siteUrl: site.siteUrl,
      actor: siteActorFor(granted, business?.name ?? ""),
      method: "POST",
      path: "/api/admin/deploy/",
      form: {},
    });
  } catch (err) {
    if (err instanceof SiteError) redirect(`${BACK}?error=site&detail=${encodeURIComponent(err.message.slice(0, 200))}`);
    throw err;
  }
  if (result.status !== 200) {
    const detail = typeof result.body.error === "string" ? result.body.error : `The site answered ${result.status}.`;
    redirect(`${BACK}?error=site&detail=${encodeURIComponent(detail.slice(0, 300))}`);
  }

  await recordAudit([
    {
      organizationId: granted.businessId,
      actorUserId: granted.ctx.userId,
      agencyGrantId: granted.via?.grantId ?? null,
      action: "site.published",
      target: site.siteUrl,
    },
  ]);
  redirect(`${BACK}?done=published`);
}

/**
 * Save a post Chat Boss proposed, as a draft, by the person who asked for it.
 *
 * The form names only the receipt; the post itself is read back from it
 * (lib/db/workspace.ts getBlogDraftReceipt — this person's own, in this
 * business), so what is saved is exactly what the card showed. It is laid over
 * the site's new-post defaults and saved through the site's own save route,
 * always as a draft. If the site refuses it (an address already in use, say),
 * the person lands in the editor with the draft filled in and the reason, so
 * nothing is lost.
 */
export async function saveBlogDraftFromChatAction(formData: FormData) {
  const granted = await requireAction("pages.edit", formData, { returnPath: `${BACK}/posts` });
  const owner = { organizationId: granted.businessId, userId: granted.ctx.userId };
  const receiptId = Number(formData.get("receiptId"));
  const receipt = await getBlogDraftReceipt(owner, receiptId);
  if (!receipt) redirect(`${BACK}/posts?error=draft`);
  const parsed = blogDraftSchema.safeParse(receipt.detail.draft);
  if (!parsed.success) redirect(`${BACK}/posts?error=draft`);

  const site = await websiteFor(owner);
  if (!site) redirect(`${BACK}?error=notconnected`);
  const editor = `${BACK}/posts/new?from=${receipt.id}`;
  if (receipt.detail.site !== site.siteUrl) {
    redirect(`${editor}&error=site&detail=${encodeURIComponent("This draft was written for a different website.")}`);
  }

  const business = await organizationById(granted.businessId);
  const actor = siteActorFor(granted, business?.name ?? "");
  let saved: { status: number; body: Record<string, unknown> };
  try {
    const base = await siteRequest({ siteUrl: site.siteUrl, actor, method: "GET", path: "/api/10xid/posts/new/" });
    if (base.status !== 200) throw new SiteError(typeof base.body.error === "string" ? base.body.error : `The site answered ${base.status}.`);
    const form = formWithDraft((base.body.form ?? {}) as Record<string, string | string[]>, parsed.data);
    saved = await siteRequest({ siteUrl: site.siteUrl, actor, method: "POST", path: "/api/admin/posts/save/", form });
  } catch (err) {
    if (err instanceof SiteError) redirect(`${editor}&error=site&detail=${encodeURIComponent(err.message.slice(0, 200))}`);
    throw err;
  }
  if (saved.status !== 200 || typeof saved.body.id !== "number") {
    const detail = typeof saved.body.error === "string" ? saved.body.error : `The site answered ${saved.status}.`;
    redirect(`${editor}&error=site&detail=${encodeURIComponent(detail.slice(0, 300))}`);
  }

  await recordAudit([
    {
      organizationId: granted.businessId,
      actorUserId: granted.ctx.userId,
      agencyGrantId: granted.via?.grantId ?? null,
      action: "site.post.saved",
      target: `${parsed.data.title.slice(0, 120)} (draft, written with Chat Boss)`,
    },
  ]);
  redirect(`${BACK}/posts/${saved.body.id}?done=saved`);
}
