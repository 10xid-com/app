import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runSiteCopy } from "@/lib/sites/site-copy";

/**
 * Start the website copy (lib/sites/site-copy.ts): every live website
 * connection's records are fetched from the site's signed export and replace
 * that business's read-only copy (login's 0038).
 *
 * For a scheduler, not a person: POST with `Authorization: Bearer
 * <CRON_SECRET>`, every few minutes. Off — a 404, as if absent — until
 * CRON_SECRET is set on the service. It lives under /api/v1/ because that is
 * the machine path the proxy lets through without a browser's Origin or a
 * session.
 *
 * Running it twice at once is harmless: each copy is replaced whole, in one
 * transaction. The answer is counts and the sites that failed, never a record.
 */
export const dynamic = "force-dynamic";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return token.length > 0 && timingSafeEqual(digest(token), digest(secret));
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 32) return new NextResponse("Not found.", { status: 404 });
  if (!authorized(request, secret)) return new NextResponse("Unauthorized.", { status: 401 });

  const run = await runSiteCopy();
  if (run.failed > 0) console.error("[site-copy] some sites were not copied:", run.errors);
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
}
