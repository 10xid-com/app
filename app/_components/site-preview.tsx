"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A live page in a browser frame: the connected website on the Website
 * channel, and the business's iD on the iD channel.
 *
 * The site is drawn at a real screen size (a 1280px desktop or a 390px phone)
 * and scaled down to fit, so it lays out exactly as a visitor sees it rather
 * than as a squeezed narrow page. It is the live site, not a picture of it:
 * it scrolls, and links work inside the frame.
 *
 * The frame is another origin (the site's), so nothing on this page is
 * reachable from it. `sandbox` still keeps it from navigating this page or
 * opening dialogs over it.
 */

const SIZES = {
  desktop: { width: 1280, height: 800, label: "Desktop" },
  phone: { width: 390, height: 844, label: "Phone" },
} as const;

type Mode = keyof typeof SIZES;

export function SitePreview({
  url,
  initialMode = "desktop",
  openLabel = "Open site",
}: {
  url: string;
  initialMode?: Mode;
  openLabel?: string;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [box, setBox] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setBox(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const size = SIZES[mode];
  // A phone is shown at a fixed share of the card; a desktop fills it.
  const target = mode === "phone" ? Math.min(box, 300) : box;
  const scale = target > 0 ? Math.min(1, target / size.width) : 0;

  return (
    <div className="bg-sunk px-4 pb-6 pt-4 sm:px-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div role="group" aria-label="Preview size" className="flex rounded-lg border border-line bg-surface p-0.5">
          {(Object.keys(SIZES) as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                // The same size keeps the same frame, which never loads again.
                if (m === mode) return;
                setLoaded(false);
                setMode(m);
              }}
              className={`rounded-md px-3 py-1 text-xs font-semibold ${
                mode === m ? "bg-brand-surface text-brand-on-surface" : "text-ink-soft hover:text-ink"
              }`}
            >
              {SIZES[m].label}
            </button>
          ))}
        </div>
        <a href={url} target="_blank" rel="noreferrer" className="text-xs font-medium text-ink-soft underline hover:text-ink">
          {openLabel}
        </a>
      </div>

      <div ref={area} className="flex justify-center">
        {scale > 0 ? (
          <div
            className={`overflow-hidden border border-line bg-surface shadow-card-lg ${mode === "phone" ? "rounded-[28px]" : "rounded-xl"}`}
            style={{ width: size.width * scale, height: size.height * scale }}
          >
            {mode === "desktop" ? (
              <div className="flex h-6 items-center gap-1.5 border-b border-line-soft bg-sunk px-3" aria-hidden>
                <span className="h-2 w-2 rounded-full bg-line" />
                <span className="h-2 w-2 rounded-full bg-line" />
                <span className="h-2 w-2 rounded-full bg-line" />
                <span className="ml-2 truncate text-[10px] text-ink-faint">{url.replace("https://", "")}</span>
              </div>
            ) : null}
            <div className="relative" style={{ height: size.height * scale - (mode === "desktop" ? 24 : 0) }}>
              {!loaded ? (
                <p className="absolute inset-0 grid place-items-center text-xs text-ink-faint">Loading…</p>
              ) : null}
              <iframe
                key={mode}
                src={url}
                title={`${url.replace("https://", "")} — ${size.label.toLowerCase()} preview`}
                loading="lazy"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                onLoad={() => setLoaded(true)}
                className="absolute left-0 top-0 origin-top-left border-0 bg-surface"
                style={{
                  width: size.width,
                  height: size.height,
                  transform: `scale(${scale})`,
                  opacity: loaded ? 1 : 0,
                }}
              />
            </div>
          </div>
        ) : (
          <div className="h-48" />
        )}
      </div>
    </div>
  );
}
