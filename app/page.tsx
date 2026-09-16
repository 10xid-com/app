import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { signOutAction } from "./auth/actions";

/**
 * Temporary landing page — replaced by the jobs screens.
 *
 * Every page in this portal is behind a sign-in; there is no public content at
 * all. That is what makes cross-domain sign-in tractable: a cold visit to any
 * client domain can simply redirect to the login host, which knows whether the
 * person is signed in, and send them straight back. Applications with public
 * pages have to work much harder.
 */
export default async function Home() {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/auth/login");

  return (
    <main className="min-h-dvh bg-ground px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            Signed in as {ctx.fullName ?? ctx.email}
          </h1>
          <dl className="mt-5 grid gap-3 text-sm">
            <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
              <dt className="text-ink-faint">Email</dt>
              <dd className="text-ink">{ctx.email}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
              <dt className="text-ink-faint">Role</dt>
              <dd className="text-ink">{ctx.role}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
              <dt className="text-ink-faint">Scoped to</dt>
              <dd className="text-ink">
                {ctx.scope.organizationId ?? "no client selected"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line-soft pb-2">
              <dt className="text-ink-faint">Idle timeout</dt>
              <dd className="text-ink tabular-nums">
                {ctx.idleSeconds ? `${ctx.idleSeconds / 60} minutes` : "none"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-faint">Signed out after</dt>
              <dd className="text-ink tabular-nums">
                {ctx.absoluteExpiresAt.toISOString()}
              </dd>
            </div>
          </dl>

          <form action={signOutAction}>
            <button
              type="submit"
              className="mt-6 rounded-lg border border-line px-4 py-2 text-sm
                         font-medium text-ink-soft transition-colors duration-150
                         hover:bg-sunk focus-visible:outline-2
                         focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Sign out everywhere
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
