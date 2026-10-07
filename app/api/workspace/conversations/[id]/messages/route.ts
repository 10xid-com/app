import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, STAFF_ACCESS } from "@/lib/auth/authorize";
import { workspaceAccess } from "@/lib/workspace/access";
import { parseCommand } from "@/lib/workspace/commands";
import { runTurn } from "@/lib/workspace/runner";

/**
 * Send a message in a workspace conversation; the answer streams back as
 * newline-delimited JSON (lib/workspace/wire.ts), one event per line.
 *
 * Who may call it is decided from the session alone: staff, as themselves,
 * with the client taken from their live grant. The conversation id in the URL
 * is checked against that client and that person by the database — another
 * client's or another person's id reads as "does not exist".
 *
 * Closing the connection cancels the run: the request's abort signal reaches
 * the provider call, and the run is recorded as cancelled with whatever text
 * had already arrived.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  content: z.string().trim().min(1).max(20_000),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const decision = await authorizeRequest(request, STAFF_ACCESS);
  if (!decision.allowed) {
    return NextResponse.json({ error: "Staff access is turned off." }, { status: 403 });
  }
  const access = await workspaceAccess(decision.ctx);
  if (!access) return NextResponse.json({ error: "The workspace is for staff." }, { status: 403 });

  // JSON only: a cross-site form can post text/plain without a preflight.
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return NextResponse.json({ error: "Send JSON." }, { status: 415 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Write a message first." }, { status: 400 });

  const { id } = await ctx.params;
  const { command, rest } = parseCommand(parsed.data.content);
  const content = rest.trim() || parsed.data.content.trim();

  const encoder = new TextEncoder();
  const events = runTurn({ access, conversationId: id, content, command, signal: request.signal });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      } catch (err) {
        if (!request.signal.aborted) console.error("[workspace] stream broke", err);
        controller.error(err);
      }
    },
    async cancel() {
      // The browser went away. Let the runner finish its closing writes: the
      // abort signal has already told the provider call to stop.
      for await (const _ of events) void _;
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
