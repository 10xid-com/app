# Session gate

The build brief (7 October 2026), instruction 4: prove two things before anything is built
on the WorkOS sign-in. The code-level proof is in the test suite; this is the part only a
deployed environment can show.

## 1. The cookie is host-only, Secure, HttpOnly, Path=/

Already proven in code (`test/session-cookie.test.ts`, `test/proxy.test.ts`): the SDK's own
callback and refresh paths, driven with a request arriving the way Railway delivers it, write
`wos-session` with `Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800` and no `Domain`.
Startup refuses any other setting (`lib/auth/origin.ts`, `sessionConfigProblems`).

On staging, and again on production after the first real sign-in:

1. Open DevTools → Network, sign in, select the request to `/callback`.
2. In its response headers, find `set-cookie: wos-session=…`. Record the attributes.
3. Pass only if it has `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, `Max-Age=604800`, and
   **no** `Domain`. Anything else: stop the deployment and report. Do not change a setting to
   make it pass.
4. Visit `https://<any other>.10xid.com` (and a client domain): no `wos-session` is sent.

## 2. How the session really behaves

WorkOS dashboard, management environment, before the test:

- Authentication → Multi-factor authentication: **Required**.
- Sessions: maximum length **7 days**, inactivity timeout **48 hours**, access token **5 minutes**.
- Redirects: callback `https://app.10xid.com/callback`, Initiate login URI
  `https://app.10xid.com/sign-in`, Sign-out URI `https://app.10xid.com/sign-in`.

Record, for each, what the person actually sees and when:

| Test | How | Record |
|---|---|---|
| Idle tab | Sign in, leave the tab untouched for > 5 min, then for > 48 h. Click a link. | Still signed in? Asked to sign in? MFA asked? |
| Background refresh | Sign in, keep the tab open and visible for an hour; watch `/` requests in DevTools. | Does `wos-session` get re-set every ~5 min? Does the 48 h clock restart without a click? |
| Phone | Sign in on a phone, use it daily for 7 days. | When was sign-in asked for again? Day 7 exactly? |
| Revocation | Remove a person's membership while they are signed in. | Their next click is refused (`/access`), cookie still valid. |
| Sign-out | Press Sign out, then press Back. | WorkOS session ended (signing in asks again)? |

The 48 hours measures time since the last token refresh, which can happen without a person
doing anything. What an owner actually experiences is for Paolo to judge; the settings are
the launch policy unless this test fails.
