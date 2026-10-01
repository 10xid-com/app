import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";

/**
 * The portal has no public landing page. Every route is behind a sign-in, which
 * is what makes cross-domain sign-in tractable: a cold visit to any client
 * domain can simply redirect to the login host, which knows whether the person
 * is signed in, and send them straight back.
 *
 * Sign-in returns here when nobody asked for a particular page, so this is
 * where staff are sent to the chat and everybody else to their dashboard. The
 * session is only read to choose between the two: both pages make their own
 * checks, so a wrong guess here costs a redirect and grants nothing.
 */
export default async function Home() {
  const ctx = await getSessionContext();
  // `role`, not `scope.isStaff`: a staff session still owed its second factor
  // has no staff scope yet, but it is about to, and the authenticator screen
  // should carry it on to the chat rather than to the dashboard.
  redirect(ctx?.role === "staff" ? "/chat" : "/dashboard");
}
