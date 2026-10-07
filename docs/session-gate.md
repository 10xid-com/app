# Session gate

What only a deployed environment can show, after the self-hosted sign-in (Better Auth on
`login.10xid.com`) goes live. The code-level proof is in the test suites — here
(`test/proxy.test.ts`, `test/auth-session.test.ts`) and in login (`test/better-auth.test.ts`,
and `test/e2e/better-auth.spec.ts` across both hosts in a real browser).

## 1. Both cookies are host-only, Secure, HttpOnly

On staging, and again on production after the first real sign-in:

1. DevTools → Network. Sign in on `login.10xid.com`. In the response to the sign-in request,
   find `set-cookie: __Secure-10xid.session_token=…`: `Secure`, `HttpOnly`, `Path=/`,
   `SameSite=Lax`, **no** `Domain`.
2. Follow the handoff to `app.10xid.com/auth/sso/callback`. Its response sets
   `__Host-portal_session=…`: `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, **no** `Domain`,
   `Max-Age` no more than seven days.
3. Visit another `*.10xid.com` host: neither cookie is sent.

Anything else: stop the deployment and report. Do not change a setting to make it pass.

## 2. How the session really behaves

| Test | How | Expected |
|---|---|---|
| Every method needs the authenticator | Sign in with a password, an emailed code, Google, Microsoft. | Each stops at "Enter your authenticator code" (or set-up) before the portal. |
| Idle | Sign in, leave everything untouched for > 48 h. Click a link in the portal. | Sent to sign in. |
| Hard end | Use the portal daily for 7 days. | Asked to sign in again 7 days after signing in, however active. |
| Revocation | On login's "Your sign-in" page, sign out another device. | That device's next portal click is sent to sign in. |
| Membership | Remove a person's membership while they are signed in. | Their next click is refused (`/access`). |
| Sign-out | Press Sign out in the portal, then Back. | Back shows the sign-in page; the portal asks to sign in again. |
| Everywhere | "Sign out everywhere" in the portal. | Every device is signed out of both hosts. |
