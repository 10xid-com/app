"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requestSignInCode, verifySignInCode } from "@/lib/auth/codes";
import {
  currentHost,
  getSessionContext,
  signOutEverywhere,
  startSession,
  writeSessionCookie,
} from "@/lib/auth/session";
import { SESSION_POLICY } from "@/lib/auth/policy";

/**
 * A "where were you going" value is always a PATH on this host, never a URL.
 *
 * Accepting a URL here is how sign-in pages get turned into open redirects that
 * launder a phishing link through a domain the victim trusts. The checks below
 * reject anything that is not plainly a local path — including the
 * protocol-relative `//evil.test` form, which a naive "starts with /" test
 * lets straight through.
 */
function safePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  if (!input.startsWith("/")) return "/";
  if (input.startsWith("//")) return "/";
  if (input.includes("\\")) return "/";
  if (/[\p{Cc}]/u.test(input)) return "/";
  return input;
}

function clientIp(h: Headers): string | null {
  // Behind Cloudflare and Railway the leftmost x-forwarded-for entry is
  // whatever the caller chose to send, so it is never trusted. Prefer the
  // platform-set header, and otherwise take the LAST hop, which was appended
  // by the nearest proxy rather than supplied by the client.
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",");
    return parts[parts.length - 1]!.trim();
  }
  return null;
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const codeSchema = z.string().trim().regex(/^\d{6}$/);

export async function requestCodeAction(formData: FormData) {
  const parsed = emailSchema.safeParse(formData.get("email"));
  const next = safePath(formData.get("next"));

  if (!parsed.success) {
    redirect(`/auth/login?error=email&next=${encodeURIComponent(next)}`);
  }

  const outcome = await requestSignInCode(
    parsed.data,
    clientIp(await headers()),
  );

  if (outcome === "rate_limited") {
    redirect(
      `/auth/login?error=rate&next=${encodeURIComponent(next)}&email=${encodeURIComponent(parsed.data)}`,
    );
  }

  redirect(
    `/auth/verify?email=${encodeURIComponent(parsed.data)}&next=${encodeURIComponent(next)}`,
  );
}

export async function verifyCodeAction(formData: FormData) {
  const email = emailSchema.safeParse(formData.get("email"));
  const code = codeSchema.safeParse(formData.get("code"));
  const next = safePath(formData.get("next"));

  if (!email.success || !code.success) {
    redirect(
      `/auth/verify?email=${encodeURIComponent(String(formData.get("email") ?? ""))}&next=${encodeURIComponent(next)}&error=invalid`,
    );
  }

  const result = await verifySignInCode(email.data, code.data);

  if (!result.ok) {
    redirect(
      `/auth/verify?email=${encodeURIComponent(email.data)}&next=${encodeURIComponent(next)}&error=${result.reason}`,
    );
  }

  const host = await currentHost();
  const { token, role } = await startSession({
    userId: result.userId,
    host,
  });

  await writeSessionCookie(
    token,
    new Date(Date.now() + SESSION_POLICY[role].absoluteSeconds * 1000),
  );

  redirect(next);
}

export async function signOutAction() {
  const ctx = await getSessionContext();
  if (ctx) {
    // Ends every session this person holds, on every domain, at once.
    await signOutEverywhere(ctx.userId, ctx.sessionId);
  }
  redirect("/auth/login");
}
