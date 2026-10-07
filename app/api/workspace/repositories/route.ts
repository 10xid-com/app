import { NextResponse } from "next/server";
import { authorizeRequest, STAFF_ACCESS } from "@/lib/auth/authorize";
import { listLinkedRepositories } from "@/lib/db/repositories";
import { githubApp } from "@/lib/repo";
import { RepoError } from "@/lib/repo/types";
import { workspaceAccess } from "@/lib/workspace/access";

/**
 * The repositories the GitHub App has been installed on, for a staff member
 * linking one to the client in scope. Names only — nothing inside any of them
 * is read here. Those already linked to this client are marked; those linked
 * to another client are not distinguishable from free ones on purpose (that
 * would say which repositories another client has), and linking one fails.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const decision = await authorizeRequest(request, STAFF_ACCESS);
  if (!decision.allowed) {
    return NextResponse.json({ error: "Staff access is turned off." }, { status: 403 });
  }
  const access = await workspaceAccess(decision.ctx);
  if (!access) return NextResponse.json({ error: "The workspace is for staff." }, { status: 403 });

  const app = githubApp();
  if (!app) return NextResponse.json({ error: "The GitHub App is not configured on this server." }, { status: 409 });

  try {
    const [available, linked] = await Promise.all([app.listAccessibleRepositories(), listLinkedRepositories(access.owner)]);
    const mine = new Set(linked.map((r) => r.externalId));
    return NextResponse.json(
      {
        repositories: available
          .map((r) => ({ externalId: r.externalId, name: `${r.owner}/${r.name}`, private: r.private, linkedHere: mine.has(r.externalId) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof RepoError) {
      // Fixed wording, never a token or key: the one place the cause is kept,
      // since the person who saw it on screen may not say what it was.
      console.warn(`[workspace] listing repositories failed: ${err.message}`);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[workspace] listing installations failed", err);
    return NextResponse.json({ error: "GitHub could not be reached." }, { status: 502 });
  }
}
