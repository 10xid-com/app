import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runExpiryReminders } from "@/lib/agency/reminders";

/**
 * Start the agency-grant expiry-reminder run (lib/agency/reminders.ts).
 *
 * For a scheduler, not a person: POST with `Authorization: Bearer
 * <CRON_SECRET>`, once a day. Off — a 404, as if absent — until CRON_SECRET
 * is set on the service. It lives under /api/v1/ because that is the machine
 * path the proxy lets through without a browser's Origin or a session.
 *
 * Running it more often, or twice at once, sends nothing twice: each reminder
 * is claimed in the database before it goes. The answer is counts only —
 * never an address.
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
  const run = await runExpiryReminders();
  if (run.failed > 0) console.error("[agency-reminders] some reminders did not send:", run.errors);
  return NextResponse.json(
    { due: run.due, sent: run.sent, failed: run.failed, skipped: run.skipped },
    { headers: { "Cache-Control": "no-store" } },
  );
}
