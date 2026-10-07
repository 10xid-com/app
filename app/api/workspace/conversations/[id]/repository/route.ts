import { NextResponse } from "next/server";
import { authorizeRequest, STAFF_ACCESS } from "@/lib/auth/authorize";
import { getLinkedRepository } from "@/lib/db/repositories";
import { getConversation } from "@/lib/db/workspace";
import { readerFor } from "@/lib/repo";
import { checkBranch } from "@/lib/repo/policy";
import { RepoError } from "@/lib/repo/types";
import { workspaceAccess } from "@/lib/workspace/access";
import { bindRepository } from "@/lib/workspace/bind";

/**
 * What the workspace's file browser shows: the conversation's repository at
 * its branch — branches, one folder at a time, search, and changed files.
 *
 * Read-only, staff only, and bound like the model's tools: the repository and
 * branch come from the conversation row, never from the request. The browser
 * names only a conversation, a path and search words, and every path passes
 * the same policy as the model's reads (secrets are listed, never opened).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, STAFF_ACCESS);
  if (!decision.allowed) {
    return NextResponse.json({ error: "Staff access is turned off." }, { status: 403 });
  }
  const access = await workspaceAccess(decision.ctx);
  if (!access) return NextResponse.json({ error: "The workspace is for staff." }, { status: 403 });

  const { id } = await ctx.params;
  const conversation = await getConversation(access.owner, id);
  if (!conversation) return NextResponse.json({ error: "That conversation does not exist here." }, { status: 404 });

  const url = new URL(request.url);
  const view = url.searchParams.get("view");

  // Branches of a repository not yet chosen for the conversation are listed
  // too, so the picker can offer them — still only a repository linked to
  // this client, checked by the database. No snapshot is needed for that.
  if (view === "branches") {
    const row = await getLinkedRepository(access.owner, url.searchParams.get("repository") ?? conversation.repositoryId ?? "");
    if (!row) return NextResponse.json({ error: "That repository is not linked to this client." }, { status: 404 });
    const reader = readerFor(row);
    if (!reader) return NextResponse.json({ error: "The GitHub App is not configured on this server." }, { status: 409 });
    try {
      return json({ defaultBranch: row.defaultBranch, branches: await reader.listBranches() });
    } catch (err) {
      return failure(err);
    }
  }

  const binding = await bindRepository(access.owner, conversation);
  if ("error" in binding) return NextResponse.json({ error: binding.error }, { status: 409 });
  const bound = binding.bound;
  if (!bound) return NextResponse.json({ error: "No repository is selected for this conversation." }, { status: 409 });
  const { reader, snap, row } = bound;

  try {
    switch (view) {
      case "tree": {
        const path = url.searchParams.get("path") ?? "";
        return json({ commitSha: snap.commitSha, truncated: snap.treeTruncated, entries: await reader.listDirectory(snap, path) });
      }
      case "search": {
        const mode = url.searchParams.get("mode") === "text" ? "text" : "filename";
        const result = await reader.search(snap, url.searchParams.get("q") ?? "", { mode });
        return json({ commitSha: snap.commitSha, ...result });
      }
      case "changed": {
        const base = url.searchParams.get("base") ?? row.defaultBranch;
        if (!checkBranch(base).ok) return NextResponse.json({ error: "That is not a branch name." }, { status: 400 });
        if (base === snap.branch) return json({ base, files: [] });
        const files = await reader.changedFiles(base, snap.commitSha);
        return json({ base, files: files.map(({ patch, ...f }) => ({ ...f, hasPatch: Boolean(patch) })) });
      }
      default:
        return NextResponse.json({ error: "Unknown view." }, { status: 400 });
    }
  } catch (err) {
    return failure(err);
  }
}

function failure(err: unknown) {
  if (err instanceof RepoError) return NextResponse.json({ error: err.message }, { status: 422 });
  console.error("[workspace] repository view failed", err);
  return NextResponse.json({ error: "GitHub could not be reached." }, { status: 502 });
}

function json(body: unknown) {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
