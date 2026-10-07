import { redirect } from "next/navigation";

/**
 * The portal has no landing page of its own. Sign-in returns here when nobody
 * asked for a particular page, and the dashboard is where everybody starts; it
 * makes its own authorization check, so this reads nothing and grants nothing.
 */
export default function Home() {
  redirect("/dashboard");
}
