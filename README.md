# 10XiD Portal

One sign-in across several domains, and a job exchange between Branding Centres and its
clients — replacing the email thread that carries that work today.

**Status: deployed.** The login host and one client domain both run on Railway from this
branch. No real DNS record has been created — the two live hosts are `up.railway.app`
subdomains, which is enough for a genuine cross-domain test because that suffix is on the
Public Suffix List.

## What it does

- **Sign in once** at the login host, then land already signed in on a site at a
  **genuinely different registrable domain**, with no second prompt, via a single-use
  ticket handoff.
- **No passwords anywhere.** A first-time account gets a six-digit emailed code; once an
  authenticator is enrolled, that code is what signs the account in and **the emailed code
  stops working for it**. Ten single-use recovery codes are issued at enrolment.
- **Accounts are by invitation**, never by open registration — a portal holds several
  companies' data, and an address typed into a form says nothing about which company its
  owner belongs to.
- **A client sees only their own company's jobs.** Staff see every client, and act on one
  at a time through a time-boxed grant carrying a typed reason.
- **Requests arrive as cards** on the dashboard, carrying what the sender actually wrote,
  and each can be given a Google Drive folder with the request filed into it.
- **A client's own systems can file work** with their own API key — write-only, bound to
  one company, revocable without touching anybody's login.

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
either a policy or a written exemption. It has caught two tables so far.

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
`/tmp/portal-signin-codes.log` and printed to the server log. In production the mailer
**refuses** to fall back to that, rather than writing codes to disk where they might be
read.

### The two domains

Cross-domain sign-in cannot be demonstrated between two subdomains of one domain; that is
ordinary cookie behaviour. Local development uses two separate registrable domains:

```
127.0.0.1  login.portal-a.test      # the only place sign-in happens
127.0.0.1  rotary.portal-b.test     # a client domain
127.0.0.1  northstar.portal-b.test  # a second client, so isolation has a target
```

## Optional integrations

Each is **inert without configuration** rather than half-working. See `.env.example`.

| | What it needs |
|---|---|
| Email (Resend) | `RESEND_API_KEY`. Without it, development writes codes to a file and production refuses to start the flow. |
| Google Drive | A service account with the `drive.file` scope, and one folder shared with it. The scope reaches only files the portal itself created. |

## Proving it

```bash
npm test          # unit and database tests, as the restricted role, against real Postgres
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
- **Sessions last until they are signed out.** Both clocks are off; the stored expiry is
  the browser's own 400-day cookie ceiling rather than a policy. What bounds a staff
  session is reach, not time — one client at a time, through a grant that lapses.

## The decision record

`docs/portal-architecture.html` — cross-domain sign-in, sessions, tenancy, the data model,
DNS, phases, costs and risks, with the reasoning for each.

Published: <https://claude.ai/artifact/Vzzyh8w5Re9zafx7kef75G> (written before the build;
the session-lifetime section has since been revised in the repo copy).
