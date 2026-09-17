import { NextResponse } from "next/server";
import { z } from "zod";
import { createJob, jobsFiledSince, type Scope } from "@/lib/db";
import { identifyKey, touchKey } from "@/lib/db/api-keys";
import { API_KEY_RATE } from "@/lib/auth/policy";

/**
 * File a job from a machine.
 *
 * This is how a client's own website hands work over — Northstar's estimate
 * form, say — where there is no person signed in to attribute it to. The
 * credential is an API key belonging to one company, and the company a job
 * lands in comes from that key and from nothing else in the request. There is
 * no company field in the body to get wrong and no header to forge: a key that
 * belongs to Northstar cannot file into Rotary, because the organization id is
 * read off the key row.
 *
 * Deliberately absent:
 *
 *   * CORS headers. This endpoint is not for browsers. A key used from browser
 *     JavaScript is a key published to everyone who loads the page, so the
 *     calling site's own server holds the key and posts from there. Withholding
 *     the headers is what makes that the only workable shape.
 *
 *   * A read endpoint. A key can put work in and cannot take anything out, so a
 *     stolen key is a nuisance rather than a disclosure. Reading a client's
 *     jobs requires a person's session.
 *
 * Known gap, stated rather than hidden: there is no idempotency key, so a
 * sender that retries after a timeout files the job twice. That needs a table
 * of seen request ids to do properly, and doing it by guessing at duplicate
 * titles would be worse than not doing it. Until then, senders should treat a
 * timeout as "may have worked".
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  title: z.string().trim().min(3).max(200),
  /**
   * From the client's side of the exchange by default: an estimate request is
   * work coming IN. A key may file the other direction too, but it has to say
   * so, because the default is the one that is nearly always right.
   */
  direction: z.enum(["from_client", "to_client"]).default("from_client"),
  /**
   * Whatever the form collected. Values are flattened to strings and capped so
   * that a sender cannot use this as free storage; the keys are kept as sent so
   * the labels stay meaningful to whoever reads the job.
   */
  details: z
    .record(z.string().min(1).max(60), z.string().max(2000))
    .optional(),
});

function unauthorized() {
  // One answer for a missing key, a malformed key, a key that never existed and
  // a key that was revoked. A caller learns that it did not work and nothing
  // else — in particular, not whether the key they are guessing at is real.
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return unauthorized();

  const key = await identifyKey(presented);
  if (!key) return unauthorized();

  // The scope is built from the key row. Note what is NOT consulted: the Host
  // header, the Origin, any field in the body. The same rule as for people —
  // which site a request arrived from carries no authority.
  const scope: Scope = {
    userId: key.serviceUserId,
    email: key.serviceEmail,
    isStaff: false,
    organizationId: key.organizationId,
  };

  const since = new Date(Date.now() - API_KEY_RATE.windowSeconds * 1000);
  const filed = await jobsFiledSince(scope, key.serviceUserId, since);
  if (filed >= API_KEY_RATE.maxJobsPerWindow) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(API_KEY_RATE.windowSeconds) } },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        // The caller is an authenticated integrator, not an anonymous visitor,
        // so telling them which field is wrong is help rather than disclosure.
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const job = await createJob(scope, {
    title: parsed.data.title,
    direction: parsed.data.direction,
    details: parsed.data.details ?? null,
  });

  await touchKey(key.organizationId, key.keyId);

  return NextResponse.json(
    { id: job.id, ref: job.ref, status: job.status },
    { status: 201 },
  );
}

/**
 * Anything other than POST.
 *
 * Next returns 405 for an unhandled method on its own, but a GET here is much
 * more likely to be somebody probing for a way to read jobs out than a mistake,
 * so it is worth being explicit that there is no such thing.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      detail:
        "This endpoint files work in. There is no read access behind an API " +
        "key — reading a client's jobs requires a signed-in person.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
