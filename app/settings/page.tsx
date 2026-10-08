import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { loginOrigin } from "@/lib/auth/origin";
import { PortalShell } from "../portal-shell";
import { ComingSoonPage } from "../_components/coming-soon";
import { SOON } from "../_components/sections";

export const metadata: Metadata = { title: "Settings" };

/**
 * Not built yet as a screen of its own. The settings that already exist live
 * elsewhere, so they are listed here rather than left for people to hunt for.
 */
export default async function SettingsPage() {
  const { ctx } = await requirePage("business.view", { returnPath: SOON.settings.href });
  const elsewhere = [
    { href: "/team", label: "Team", purpose: "Who is in the business, and their roles." },
    { href: "/business", label: "Your businesses", purpose: "Switch which business is open." },
    { href: `${loginOrigin() ?? ""}/auth/account`, label: "Sign-in & security", purpose: "Sessions, authenticator and recovery codes." },
    { href: "/pages", label: "Pages", purpose: "Every page in the portal." },
  ];
  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <ComingSoonPage section={SOON.settings}>
        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-ink-faint">Available now</h2>
        <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {elsewhere.map((item) => (
            <li key={item.label}>
              <Link href={item.href} className="block px-4 py-3 transition-colors hover:bg-sunk">
                <span className="block text-sm font-medium text-ink">{item.label}</span>
                <span className="block text-sm text-ink-soft">{item.purpose}</span>
              </Link>
            </li>
          ))}
        </ul>
      </ComingSoonPage>
    </PortalShell>
  );
}
