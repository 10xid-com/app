import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionContext } from "@/lib/auth/session";
import { CHAT_CHOICES } from "@/lib/ai/models";
import { ChatError, chatIsConfigured, startChat } from "@/lib/ai/openrouter";

/**
 * The chat box's one call: a conversation in, the answer streamed back as
 * plain text.
 *
 * Staff only, decided here and not just on the page. The page hiding the box
 * from a client is presentation; this is the check — and it is the one that
 * stops a client account spending the shared free allowance or sending their
 * data to a third-party model.
 *
 * Nothing is stored. The conversation lives in the browser tab that holds it,
 * and the server forgets each request when the answer ends. That keeps the
 * chat outside the tenancy rules entirely: it reads no row and writes no row,
 * so there is no scope for it to get wrong.
 */

export const dynamic = "force-dynamic";

/**
 * Bounds on what one request may carry. Generous for a working conversation,
 * and small enough that the endpoint cannot be used to push megabytes at a
 * free model on our key.
 */
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 80_000;

const bodySchema = z.object({
  model: z.enum(CHAT_CHOICES),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_MESSAGES)
    .refine((m) => m[m.length - 1]!.role === "user", {
      message: "The last message must be the person's.",
    })
    .refine(
      (m) => m.reduce((n, x) => n + x.content.length, 0) <= MAX_TOTAL_CHARS,
      { message: "The conversation is too long. Start a new one." },
    ),
});

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  const ctx = await getSessionContext();
  // A staff session that has not cleared its second factor is not yet a staff
  // session, here exactly as on every page.
  if (!ctx || ctx.needsSecondFactor) return fail(401, "Sign in again.");
  if (!ctx.scope.isStaff) return fail(403, "The chat is for staff.");

  // JSON only. A cross-site form can post text/plain without a preflight; it
  // cannot post application/json. The session cookie is SameSite=Lax as well,
  // so this is the second lock on the same door, not the only one.
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return fail(415, "Send JSON.");
  }

  if (!chatIsConfigured()) {
    return fail(503, "The chat is not set up yet: OPENROUTER_API_KEY is empty.");
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail(400, parsed.error.issues[0]?.message ?? "That request was not valid.");
  }

  let started: Awaited<ReturnType<typeof startChat>>;
  try {
    started = await startChat({ ...parsed.data, signal: request.signal });
  } catch (err) {
    if (err instanceof ChatError) return fail(502, err.message);
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("[chat] failed to start", err);
    return fail(502, "The model could not be reached.");
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await started.text.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (err) {
        // Mid-answer. The words already sent stay on screen; the browser sees
        // the stream break and says the answer was cut off.
        if (!request.signal.aborted) console.error("[chat] stream broke", err);
        controller.error(err);
      }
    },
    async cancel() {
      await started.text.return(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      // Which model is ACTUALLY answering — after a fallover, not the one the
      // picker asked for.
      "X-Chat-Model": started.model,
    },
  });
}
