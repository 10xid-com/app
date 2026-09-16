# 10XiD Portal

One sign-in across several domains, and a job exchange between Branding Centres and its
clients — replacing the email thread that carries that work today.

**Status: Phase 1 built and proven locally. Nothing deployed, no DNS record created.**

This repository also holds the earlier architecture record for the 10XiD card editor,
which shares the `login.10xid.com` host. That work is still design-only.

## What Phase 1 does

- Sign in once at the login host with a six-digit emailed code — no passwords anywhere.
- Land already signed in on a site at a **genuinely different registrable domain**, with
  no second prompt, via a single-use ticket handoff.
- A client sees only their own company's jobs. Staff see every client, and act on one at
  a time through a time-boxed grant carrying a typed reason.
- A job is a title, a client, a status and a date. Files, message threads, proof
  approvals and notifications are designed for but deliberately not built yet.

## Documents

| File | What it is |
|---|---|
| `docs/portal-architecture.html` | The portal decision record — cross-domain sign-in, sessions, tenancy, data model, DNS, phases, costs, risks |
| `docs/login-architecture.html` | The earlier card-editor record — session and cookie design, rendering, migration |
| `docs/content-model-observed.md` | The card content model, inventoried from live cards rather than assumed |

Published portal record: <https://claude.ai/artifact/Vzzyh8w5Re9zafx7kef75G>

## The rule everything else serves

**Every database read and write is scoped to the signed-in person's company**, through one
shared helper that takes the session and returns an already-scoped query. It is enforced
twice, deliberately, because the two layers fail differently:

- `lib/db/index.ts` — the only surface the application may use. Every function takes the
  scope first, so there is no unscoped variant to reach for in a hurry. An ESLint rule
  fails the build if anything outside `lib/db/` imports the connection module.
- Postgres row-level security underneath — which catches what the helper cannot, notably
  a nested relation load applying its own filter.

The application **refuses to start** if its database role is a superuser, can bypass
row-level security, or owns the tables. That is the case where Postgres silently ignores
every policy and an isolation test passes while proving nothing.

`npm run db:rls-check` fails the build if a new table carries an organization id without
either a policy or a written exemption.

## Running it locally

Needs Node 22+ and PostgreSQL 16.

```bash
npm install
cp .env.example .env.local        # then fill in the two connection strings

npm run db:migrate                # runs as the OWNER
npm run db:seed                   # two client companies, one internal, three people
npm run dev
```

Two connection strings, and they must differ: `DATABASE_URL` owns the tables and runs
migrations, `DATABASE_APP_URL` is the restricted role the application connects as.

Sign-in codes are not emailed in development — they are appended to
`/tmp/portal-signin-codes.log` and printed to the server log.

### The two domains

Cross-domain sign-in cannot be demonstrated between two subdomains of one domain; that is
ordinary cookie behaviour. Local development uses two separate registrable domains:

```
127.0.0.1  login.portal-a.test      # the only place sign-in happens
127.0.0.1  rotary.portal-b.test     # a client domain
127.0.0.1  northstar.portal-b.test  # a second client, so isolation has a target
```

## Proving it

```bash
npm test          # 11 isolation tests against a real Postgres, as the restricted role
npm run test:e2e  # browser tests across Chrome and Firefox, normal and fresh profiles
npm run prove     # signs in as a real client and guesses another client's job address
```

`npm run prove` prints a transcript rather than an assertion:

```
── the attempt: another client's job, by its exact real id ───────
  HTTP 404 Not Found
  contains their job title:   false
  bytes of their data leaked: 0

  Same status for a real job and an imaginary one: yes
```

That last line matters. An endpoint that answered differently for a real job than an
imaginary one would confirm which ids exist, and could be walked to enumerate a
competitor's workload.

## Measured, not assumed

| | Chrome | Chrome (fresh) | Firefox | Firefox (fresh) |
|---|---|---|---|---|
| Cross-domain handoff | 506ms | 494ms | 791ms | 858ms |
| Sign-out propagation | 257ms | 282ms | 405ms | 421ms |

Sign-out ends the session on every domain in one request, because the session row is
revoked and there is no short-lived token left alive to outlive it.

**Safari is not tested**, by decision. A Linux container cannot run it, and the nearest
engine available is not the same thing where it matters.

## Conventions worth knowing

- **Next.js 16 renamed middleware to `proxy.ts`.** It does one cheap thing: send a
  cookie-less request on a client domain into the handoff. It deliberately does not
  validate sessions — that belongs in the data layer.
- **Versions are pinned exactly.** Drizzle's documentation site describes 1.0 while npm
  installs 0.45.2 with a different migration layout, so a caret produces a build that
  does not match its own documentation.
- **Job ids in URLs are UUIDv7**, generated in application code because Postgres 16 has no
  native `uuidv7()`. The human reference (`ROT-0042`) is per-client sequential and never
  appears in a URL, since it would otherwise leak how many jobs a client has.
- **The hostname decides branding, never permission.** What a person may read comes from
  their session. The address bar carries no authority.
