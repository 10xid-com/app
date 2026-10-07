/**
 * Runs once when a server instance starts, before it handles any request.
 *
 * The tenant-isolation design rests on the application connecting as a
 * restricted database role. If it ever connects as the owner or a superuser,
 * Postgres silently ignores every row-level security policy — no error, no
 * warning, and every client can read every other client's data.
 *
 * Silent is the problem. So the check runs here, at startup, and refuses to let
 * a misconfigured deployment serve traffic at all rather than serving it
 * unsafely. The function existed before this file did and was never called,
 * which made the guarantee a comment rather than a guard.
 */
export async function register() {
  // Only the Node.js runtime can reach the database; the edge runtime cannot.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The two hosts. A deployment missing one stops here rather than issuing a
  // session cookie for the wrong host or sending people to the wrong sign-in.
  if (process.env.NODE_ENV === "production") {
    const { obsoleteVariables, sessionConfigProblems } = await import("./lib/auth/origin");
    const problems = sessionConfigProblems(process.env);
    if (problems.length > 0) {
      throw new Error(`[startup] session settings: ${problems.join("; ")}`);
    }
    const obsolete = obsoleteVariables(process.env);
    if (obsolete.length > 0) {
      console.warn(`[startup] unused variables, remove at cutover: ${obsolete.join(", ")}`);
    }
    console.log("[startup] session settings verified");
  }

  const { assertRestrictedRole } = await import("./lib/db/connection");
  await assertRestrictedRole();
  console.log("[startup] database role verified: not privileged, RLS applies");
}
