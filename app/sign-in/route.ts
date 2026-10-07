import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { safePath } from "@/lib/auth/paths";

/**
 * Begin a WorkOS sign-in, and come back to `returnTo` afterwards.
 *
 * Also the "Initiate login URI" to set in the WorkOS dashboard. `returnTo` is
 * only ever a local path (safePath); anything else becomes "/".
 */
export async function GET(request: NextRequest) {
  const returnTo = safePath(request.nextUrl.searchParams.get("returnTo"));
  redirect(await getSignInUrl({ returnTo }));
}
