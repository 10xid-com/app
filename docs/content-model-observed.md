# 10XiD — observed content model (from live cards, 2026-09-12)

Sampled: https://10xid.com/vwt/ (Vinyl Wrap Toronto), https://10xid.com/nusens/ (Nusens Contracting LTD.)
Platform: WordPress 7.1 + Elementor 4.2.4 behind Cloudflare. Each card is a hand-built Elementor page.

## Present on BOTH cards (treat as core)

| Field | Notes |
|---|---|
| Business name | "Vinyl Wrap Toronto", "Nusens Contracting LTD." |
| Tagline | "Vehicles, Windows and Walls" / "Problem Solving Meets Construction" |
| Logo | PNG. VWT: `menu-admin-logo.png`. Nusens: "Nusens Logo 2018" |
| Description / about | Free prose. Length varies a lot (Nusens has a full origin narrative) |
| Phone | rendered as `tel:` — Nusens `tel:18666873670` |
| Email | `mailto:`, **obfuscated** in markup (`[email protected]` pattern) |
| Website | external link (VinylWrapToronto.com / nusens.ca) |
| QR code | base64-encoded PNG inline. UI hint: "Long press on the QR code to download" |
| Social links | variable set, see below |
| Popups | Elementor popups fired from icon clicks (VWT IDs 2119, 1984, 1622, 1919, 1928, 1935) |
| Per-section custom icons | VWT references ~18 section icons + 8 social icons |

## Present on only ONE card — this is the important finding

| Field | VWT | Nusens |
|---|---|---|
| Hours of operation | ✅ Mon–Fri 8:30–17:00, Sat 10:00–18:00, Sun closed | ❌ absent |
| Street address | ❌ absent | ✅ 25 Chauncey Ave, Etobicoke, ON M8Z 2Z2 |
| Map providers | ❌ none | ✅ **four** — Google Maps, Waze, Apple Maps, MapQuest |
| Links to own site's inner pages | ✅ 8 (Home, Car/Van/Truck/Trailer/Boat Wraps) | ❌ absent |
| Google Business Profile / Reviews | ✅ both | ❌ absent |
| Social platforms | FB, Twitter/X, IG, LinkedIn **personal + company**, YouTube, Reddit, Tumblr, Pinterest (9) | FB, Twitter/X, IG, LinkedIn (4) |

Neither card had: forms, testimonials, galleries, video.

## Consequence for the schema

**The field set is not fixed across customers.** A wide table with one column per
field (phone, email, address, hours, facebook, instagram…) is the wrong shape — VWT
has nine socials and no address; Nusens has an address with four map providers and no
hours. LinkedIn appears twice on one card, so even "one row per platform" is wrong.

Model it as **an ordered list of typed blocks** belonging to a card:

- `card` — slug, business name, tagline, description, logo, theme (colours), background
  (desktop + mobile), published state
- `card_block` — card_id, position, type, payload(JSON), visible
  - types observed: `phone`, `email`, `website`, `address`, `hours`, `social`, `link`,
    `qr`, `review_link`
  - `address` payload carries the address plus **which** map providers to emit
    (google/waze/apple/mapquest) — derived links, not stored ones
  - `social` payload carries platform + handle/URL + optional label, so LinkedIn
    personal and LinkedIn company are two ordinary blocks
  - `hours` payload is structured per weekday with a closed flag

Derived, never stored: `tel:` / `mailto:` / maps / Waze / WhatsApp URLs, the QR code
PNG, and the vCard. Generate them from the blocks at render time.

## Two things to carry forward

1. **Keep the email obfuscation.** Current cards hide the address in markup. Rendering
   a bare `mailto:` on a new build would be a regression that customers notice as spam.
2. **Elementor popups have no equivalent yet.** Six popups on the VWT card alone. Work
   out what they contain before cloning, or the rebuilt card quietly loses behaviour.
   This is the most likely source of "the new one is missing something" complaints.

## Migration inventory (live, paying, must not break)

`/vwt/` `/wwt/` `/proforestree/` `/nusens/` `/henao-gc/` `/gsquared/` `/dans-disposal/`
— plus any not listed on the public featured page. Get the full list from WordPress
before cutover; these URLs are on customers' printed cards and QR codes.
