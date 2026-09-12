# 10XiD Login

Sign-in at `login.10xid.com` and the self-serve editor behind it, so 10XiD customers
can update their own digital business card and staff can reach every card, auditably.

**Status: design only. No application code yet.**

## Why this exists

10XiD sells a digital business card for $10/month and the plan promises *"Unlimited
Updates"* — but there is no customer-facing editor. Today every update is a manual
Elementor edit on 10xid.com (WordPress 7.1 + Elementor 4.2.4). This project turns that
support burden into the product.

## Documents

| File | What it is |
|---|---|
| `docs/login-architecture.html` | The architecture decision record — session and cookie design, rendering, tenancy, staff access and audit, build-vs-buy, migration, phased plan, costs |
| `docs/content-model-observed.md` | The real content model, inventoried from live cards rather than assumed |

Open the architecture record in a browser, or read the published version:
<https://claude.ai/code/artifact/db84cd13-d01f-49e9-962b-25d4a14785b7>

## The decisions already settled

1. **Wrap Authority only edits its own 10XiD.** Cross-registrable-domain single sign-on
   is out of scope for now — but the seam for it is preserved (see the record).
2. **Astro renders the cards**, cloned from the existing Elementor pages. WordPress is
   on its way out.
3. **"Keep me signed in" is ~30 days for customers**, silently renewing so it never
   breaks unexpectedly; **staff are capped at 8 hours** plus a 30-minute idle timeout,
   because a staff session can reach every customer's data.
4. **No role picker on the sign-in form.** One form; the server reads the role off the
   account record after authenticating.

## The three shortest answers, if you read nothing else

- A cookie that never expires is not possible — browsers clamp at 400 days. What is
  wanted is a session that never *breaks*, which is two server-side clocks.
- The session cookie is **host-scoped with the `__Host-` prefix**, not scoped to
  `.10xid.com`. The public cards are anonymous pages and need no session at all, and
  WordPress shares the apex domain.
- A customer edit reaches the live page by **cache-tag purge**, not a rebuild — one
  card's edit must never redeploy every customer's card.

## Existing URLs that must not break

`/vwt/` `/wwt/` `/proforestree/` `/nusens/` `/henao-gc/` `/gsquared/` `/dans-disposal/`

These are live, paying customers, **with the trailing slash**, printed on vehicles and
encoded in QR codes that cannot be reprinted. They must return 200, never a redirect.
