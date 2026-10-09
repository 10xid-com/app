import type { LiveId } from "@/lib/sites/id";
import { Icon } from "../../_components/icons";
import { SitePreview } from "../../_components/site-preview";

/** The iD page's body, apart from the session and the database. */

const THEMES = [
  { name: "Classic", note: "Quiet and even, for any business.", band: "bg-brand", plate: "bg-surface" },
  { name: "Bold", note: "Big type and a full-colour header.", band: "bg-ink", plate: "bg-brand-soft" },
  { name: "Minimal", note: "Just the Mark, the name and the links.", band: "bg-line", plate: "bg-surface" },
];

export function IdChannelView({
  name,
  logo,
  address,
  live = null,
}: {
  name: string;
  logo: string;
  address: string;
  live?: LiveId | null;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">iD</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        Your iD is the one link that holds the business: who you are, how to reach you, and everything you do.
      </p>

      <section aria-label="Your iD" className="mt-6 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        {live ? (
          <SitePreview url={live.previewUrl} initialMode="phone" openLabel="Open preview" />
        ) : (
          /* A drawing of the iD, not the iD itself: this business has none yet. */
          <div className="grid place-items-center bg-sunk px-4 py-10 sm:py-14">
            <div className="w-full max-w-[300px] overflow-hidden rounded-[22px] border border-line bg-surface shadow-card-lg">
              <div className="h-16 bg-brand" />
              <div className="-mt-8 px-5 pb-6">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logo}
                  alt=""
                  className="h-16 w-16 rounded-[6px] border-4 border-surface bg-surface object-contain"
                />
                <p className="mt-2 text-[17px] font-[650] tracking-[-0.01em] text-ink">{name}</p>
                <p className="text-xs text-ink-faint">{address}</p>
                <div className="mt-4 space-y-2" aria-hidden>
                  {["Website", "Book a call", "Instagram"].map((l) => (
                    <div key={l} className="rounded-full border border-line-soft bg-sunk px-4 py-2 text-center text-[13px] font-[520] text-ink">
                      {l}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-4 py-3 sm:px-5">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-ink">
            <Icon name="markets" className="h-4 w-4 text-ink-faint" />
            <span className="truncate">{address}</span>
          </p>
          <div className="flex gap-2">
            {live ? (
              <a href={live.launchUrl} target="_blank" rel="noreferrer" className={secondary}>
                Launch iD
              </a>
            ) : (
              <button type="button" disabled title="Coming soon" className={secondary}>
                Launch iD
              </button>
            )}
            <button type="button" disabled title="Coming soon" className={primary}>
              Edit iD
            </button>
          </div>
        </div>
      </section>
      <p className="mt-2 text-xs text-ink-faint">
        {live ? "Editing your iD is coming soon." : "Launching and editing your iD are coming soon."}
      </p>

      <div className="mt-10 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Themes</h2>
          <p className="text-sm text-ink-soft">The looks your iD can wear. Adding one is coming soon.</p>
        </div>
      </div>
      <ul className="mt-4 grid gap-4 sm:grid-cols-3">
        {THEMES.map((t) => (
          <li key={t.name} className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            <div aria-hidden className="grid h-32 place-items-center bg-sunk">
              <div className={`w-24 overflow-hidden rounded-lg border border-line ${t.plate}`}>
                <div className={`h-5 ${t.band}`} />
                <div className="space-y-1.5 p-2">
                  <div className="h-2 w-12 rounded-full bg-ink/70" />
                  <div className="h-2 rounded-full bg-line" />
                  <div className="h-2 rounded-full bg-line" />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-line-soft px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{t.name}</p>
                <p className="truncate text-xs text-ink-soft">{t.note}</p>
              </div>
              <button type="button" disabled title="Coming soon" className={secondary}>
                Add
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

const secondary =
  "rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink " +
  "disabled:cursor-not-allowed disabled:opacity-60";
const primary =
  "rounded-lg bg-brand-surface px-3 py-1.5 text-[13px] font-semibold text-brand-on-surface " +
  "disabled:cursor-not-allowed disabled:opacity-60";
