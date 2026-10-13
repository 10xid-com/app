import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { loginOrigin } from "@/lib/auth/origin";
import { organizationById } from "@/lib/db/identity";
import { PortalShell } from "../portal-shell";
import { CsrfField } from "../_components/csrf-field";
import { saveBusinessDetailsAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };

const ERRORS: Record<string, string> = {
  name: "A business name needs 2 to 80 characters.",
  brandPrimaryHex: "The brand colour is written #RRGGBB, for example #1d4ed8.",
  brandLogoUrl: "The logo needs an https:// address of an image, up to 500 characters.",
  memberVisibility: "Choose whether your team can see each other.",
};

const input =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint " +
  "focus:border-brand focus:outline-2 focus:outline-brand/30 disabled:bg-sunk disabled:text-ink-soft";

/**
 * The business's details, editable by its owners and managers; everyone else
 * in the business sees them read-only. The settings that live on other
 * screens are listed underneath rather than left for people to hunt for.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const granted = await requirePage("business.view", { returnPath: "/settings" });
  const { ctx, role, via, businessId } = granted;
  const params = await searchParams;
  const business = await organizationById(businessId);
  const canEdit = allows(role, "business.edit", via);

  const elsewhere = [
    { href: "/team", label: "Team", purpose: "Who is in the business, and their roles." },
    { href: "/business", label: "Your businesses", purpose: "Switch which business is open." },
    { href: `${loginOrigin() ?? ""}/auth/account`, label: "Sign-in & security", purpose: "Sessions, authenticator and recovery codes." },
    { href: "/channels", label: "Channels", purpose: "Connect your website, Instagram and Facebook." },
    { href: "/pages", label: "Pages", purpose: "Every page in the portal." },
  ];

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Settings</h1>
      <p className="mt-1 text-sm text-ink-soft">The business&rsquo;s details and how the portal works for it.</p>

      {params.saved ? (
        <p role="status" className="mt-5 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          {params.saved === "1" ? "Saved." : "Nothing had changed."}
        </p>
      ) : null}
      {params.error ? (
        <p role="alert" className="mt-5 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {ERRORS[params.error] ?? "That did not save."}
        </p>
      ) : null}

      <section className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Business details</h2>
          {canEdit ? null : <span className="text-xs text-ink-faint">Owners and managers can change these.</span>}
        </div>

        <form action={saveBusinessDetailsAction} className="mt-4 grid gap-5">
          <CsrfField />
          <fieldset disabled={!canEdit} className="grid gap-5">
            <label className="grid gap-1.5">
              <span className="text-sm font-medium text-ink">Name</span>
              <input name="name" required minLength={2} maxLength={80} defaultValue={business?.name ?? ""} className={input} />
            </label>

            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <label className="grid gap-1.5">
                <span className="text-sm font-medium text-ink">Brand colour</span>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-9 w-9 flex-none rounded-lg border border-line"
                    style={{ background: business?.brandPrimaryHex ?? "transparent" }}
                  />
                  <input
                    name="brandPrimaryHex"
                    placeholder="#1d4ed8"
                    pattern="#[0-9a-fA-F]{6}"
                    defaultValue={business?.brandPrimaryHex ?? ""}
                    className={`${input} font-mono`}
                  />
                </span>
              </label>
              <label className="grid gap-1.5">
                <span className="text-sm font-medium text-ink">Logo address</span>
                <span className="flex items-center gap-2">
                  {business?.brandLogoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the business's own logo, any host
                    <img src={business.brandLogoUrl} alt="" className="h-9 w-9 flex-none rounded-lg border border-line object-contain" />
                  ) : (
                    <span aria-hidden className="h-9 w-9 flex-none rounded-lg border border-dashed border-line" />
                  )}
                  <input
                    name="brandLogoUrl"
                    type="url"
                    placeholder="https://…/logo.png"
                    defaultValue={business?.brandLogoUrl ?? ""}
                    className={input}
                  />
                </span>
              </label>
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-ink">Who your team can see</legend>
              {(
                [
                  ["closed", "People see only the teammates they are connected to."],
                  ["open", "Everyone in the business can see everyone else on the Team page."],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className="flex items-start gap-2.5 text-sm text-ink">
                  <input
                    type="radio"
                    name="memberVisibility"
                    value={value}
                    defaultChecked={(business?.memberVisibility ?? "closed") === value}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{value === "open" ? "Open" : "Closed"}</span>
                    <span className="text-ink-soft"> — {text}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </fieldset>

          {canEdit ? (
            <div>
              <button
                type="submit"
                className="rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface
                           transition-colors hover:bg-brand-surface-hover focus-visible:outline-2
                           focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Save
              </button>
            </div>
          ) : null}
        </form>
      </section>

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-ink-faint">Elsewhere</h2>
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
    </PortalShell>
  );
}
