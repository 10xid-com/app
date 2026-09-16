import { redirect } from "next/navigation";

/**
 * The portal has no public landing page. Every route is behind a sign-in, which
 * is what makes cross-domain sign-in tractable: a cold visit to any client
 * domain can simply redirect to the login host, which knows whether the person
 * is signed in, and send them straight back.
 */
export default function Home() {
  redirect("/jobs");
}
