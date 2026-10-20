# 10XiD Portal — app

The portal at **`app.10xid.com`**: the dashboard, requests and jobs, and the team screen.
It answers on that host and **no other** — client domains get nothing from it and carry no
management cookie (Revision 2; Paolo's decision of 2026-10-07).

**The portal signs people in itself**, at `/auth/sign-in`: a code emailed to the address on
file, then the code from an authenticator app, every time. It is not tied to
[`login.10xid.com`](https://github.com/10xid-com/login) (which keeps the UiD sign-in, the
schema and the migrations): nothing here sends anyone there, and a session handed over from
there is refused. Who may do what is answered by one central authorization function
(`lib/auth/authorize.ts`) that every protected page, server action and route handler passes
through.

Both apps use **one database**. `lib/db/schema.ts` here is a copy of login's, kept
identical by CI (`.github/workflows/database.yml`): a schema change is made in login, with
its migration, then copied here unchanged.

## What it does

- **Sign in here** (`app/auth/*`, `lib/auth/codes.ts`):
  1. `/auth/sign-in` — the address. A six-digit code is emailed to it if it has an account or a
     live invitation; the screen says the same thing either way. Or, for somebody who has set
     one, the address and a password (`lib/auth/password.ts`, scrypt, login's 0053): it stands
     in for the emailed code and leads to the same pending session. Only an account with a
     confirmed authenticator can use it; ten wrong passwords per address per quarter hour.
  2. `/auth/verify` — the emailed code (ten minutes, one use, five tries). It makes a *pending*
     session, which opens the authenticator screens and nothing else, for fifteen minutes.
  3. `/auth/authenticator` — the authenticator app's code, or one of ten recovery codes. The
     first time, setting the app up instead, then the recovery codes are shown once. Ten wrong
     codes per account per quarter hour, and it stops accepting any.
  Then a new session under a new token: a random value in a host-only `__Host-portal_session`
  cookie (`Secure`, `HttpOnly`, `SameSite=Lax`), only its hash stored.
- **An invitation is accepted at the first sign-in** with a code emailed to exactly that
  address; the account is created then, into the business the invitation names.
- **Sessions** last seven days from signing in at most and lapse after 48 hours idle. Agency
  access needs the authenticator within the last day, approving it within five minutes:
  `/auth/confirm` asks for a fresh code. `/auth/security` sets or removes the password (with the
  authenticator within five minutes), makes a new set of recovery codes and signs out everywhere. Sessions handed over from login.10xid.com are refused, so everybody
  signs in here once.
- **Six role templates** — owner, manager, editor, publisher, asset manager, viewer — and the
  permission matrix that says what each may do (`lib/auth/permissions.ts`, Paolo's decisions of
  2026-10-07). Owners and managers invite, change and remove people, but only an owner can
  make, change or remove an owner, and a business always keeps one (enforced by login's 0024
  trigger as well). Approving, asking for changes, cancelling, completing unapproved work, and
  undoing any of those, is owners' and managers' alone.
- **A business switcher** (`/business`): somebody in several businesses chooses which one is open,
  per portal session, and can switch from the account menu. The choice is re-checked against their
  live memberships on every request; with one business it simply opens.
- **Every state-changing request** needs the exact `https://app.10xid.com` Origin and a CSRF
  token bound to the session (an HMAC keyed by the session cookie's secret).
- **Agency access** replaces Act as. An agency (Branding Centres, to begin with) asks a business
  for access at a role below owner, for at most a year (90 days by default), and names its people;
  the business's owner approves the access and each person. Agency people never become members,
  never manage people, grants, billing, domains or ownership, need the authenticator within the
  last day, and lose access when blocked, ended or expired. Approving needs the authenticator
  within five minutes. Every decision, and everything state-changing done through agency
  access, goes on the business's audit record.
- **Staff access is off.** The Clients and Keys screens are still in the code and refused to
  everybody.
- **Requests arrive as cards** on the dashboard, carrying what the sender actually wrote,
  and each can be given a Google Drive folder with the request filed into it.

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

Row-level security policies, and the check that every table carrying an organization id
has one, live with the migrations in `10xid-com/login`.

## Running it locally

Needs Node 22+, PostgreSQL 18, and a checkout of `10xid-com/login` next to this one
(`../login`) for the migrations.

```bash
npm install
cp .env.example .env.local        # connection strings, PORTAL_HOST=app.portal-a.test:3001,
                                  # SESSION_COOKIE_SECURE=false, TOTP_ENC_KEY=$(openssl rand -base64 32)

# Database, from login (once, and after any schema change there):
(cd ../login && npm install && npm run db:migrate && npm run db:seed)

npm run dev -- -p 3001
```

Then open `http://app.portal-a.test:3001/` (with `127.0.0.1 app.portal-a.test` in
`/etc/hosts`). Any other host is answered with a 404, by design. Without `RESEND_API_KEY`,
sign-in codes are written to `DEV_CODE_SINK` (`/tmp/portal-signin-codes.log`).

## Optional integrations

Each is **inert without configuration** rather than half-working. See `.env.example`.

| | What it needs |
|---|---|
| Email (Resend) | `RESEND_API_KEY`. Without it, development writes codes to a file and production refuses to start the flow. |
| iD channel | `ID_PREVIEWS`, as `<business slug>:<iD slug>` pairs. That business's iD page shows its iD live from `preview.10xid.com`, and Launch iD opens `<iD slug>.10xid.com`. |
| Google Drive | A service account with the `drive.file` scope, and one folder shared with it. The scope reaches only files the portal itself created. |
| Optional alternate workspace engines (Claude, OpenAI) | `ANTHROPIC_API_KEY` for the Claude modes; `OPENAI_API_KEY` plus `OPENAI_MODEL_MULTIMODAL` / `OPENAI_MODEL_REVIEW` for the OpenAI modes. They remain in the repository but are not the stated Chat Boss provider intent. See "The workspace" below. |
| Ollama (prototype) | `ENABLE_PROTOTYPE_ENGINE=true` and `OLLAMA_API_KEY` for Ollama Cloud. One picker entry per model in `OLLAMA_MODELS`, plus Auto. Text only, no tools, house workspace only — unless `OLLAMA_CLOUD_CLIENT_DATA=true`, which gives it the job and repository tools and client workspaces. |
| Inventory | `INVENTORY_BUSINESSES` (organization ids) switches /inventory on per business; owners catalogue containers from phone photos into the media bucket (`inventory/<business>/`). `INVENTORY_VISION_MODEL` lets an Ollama model read the labels — on Ollama Cloud only with `OLLAMA_CLOUD_CLIENT_DATA=true`. Without it the review form is filled in by hand. |
| Ollama (self-hosted) | `OLLAMA_SELF_HOSTED=true`, `OLLAMA_BASE_URL` naming your own server, and `OLLAMA_MODELS`. Context and tools like Claude; replaces the prototype. |

## The workspace

> **Provider intent:** Chat Boss is intended to use **Ollama**. No Ollama model or base URL is
> prescribed here; those are deployment choices. The repository currently also contains Anthropic
> and OpenAI engine modes. Whether those alternatives should remain available inside `/chat` is a
> separate architecture decision, so this clarification does not remove or rewrite them.

**Turned off** with the rest of staff access on 2026-10-07: every entry point asks the central
function for staff access, which no role carries. What follows describes it as built.

`/chat` is where staff land: one client's workspace, with conversations kept per client **and per
person** — two staff on the same client do not read each other's conversations. Postgres enforces
both (0018: `app.org_id` and `app.user_id`), and child rows reference their parent by
(id, client, owner) so nothing can be attached to someone else's conversation.

- **The client** is the session's live staff grant, opened from the workspace with a reason exactly
  as on the Clients page. With no grant, the workspace belongs to the house and holds no client data.
- **Ask** answers from the client's records and cites them as `[JOB ROT-0042]`; **Plan** writes a
  step-by-step plan. Neither changes anything. **Build** is shown, disabled, and refused by a database
  constraint until approval, audit and rollback exist.
- **Engines** are modes (`Claude — Coding`, `Claude — Deep analysis`, `OpenAI — Multimodal`,
  `OpenAI — Review`) mapped to model names in the environment, so an upgrade is a variable change.
  One run goes to one provider; a client can be kept off a mode with an `engine_mode_policies` row.
- **Receipts.** Every record the model was given, every tool it ran and every warning is a row,
  written as it happens, and shown in the right-hand panel — "what did the model see?" is answered
  from the database, not from the answer's text.
- `/review`, `/explain`, `/plan` and `/test` are recorded choices with fixed, visible wording
  (`lib/workspace/commands.ts`), never hidden prompts.

- **Repositories** are read through a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`), never a
  person's token. A repository is linked to **one client at a time** (0019); a conversation picks one
  linked repository and a branch. Each answer resolves the branch to one commit and reads only that
  commit, through eight read-only tools — `list_repositories`, `list_branches`,
  `list_repository_tree`, `read_repository_file`, `search_repository`, `get_commit_history`,
  `get_changed_files`, `create_patch_preview` — bound on the server to the conversation's repository:
  the model names paths, never a repository. `lib/repo/policy.ts` refuses traversal, secrets
  (`.env`, keys, credential files), `.git/`, binaries, symbolic links and submodules, and caps every
  read, listing and search. Each file read is a receipt naming `path`, lines and commit. A patch
  preview is a diff to read and copy; nothing is ever written to a repository.
- **`@path`** and **`@folder:path`** in a message add that file or folder to the conversation's
  context; context files send their first 120 lines, and the model reads further with its tools.

Attachments (private Backblaze B2 storage) come next.

The browser tests for grounded answers run against a local stand-in for the Anthropic API:

```bash
ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 \
GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY="$(openssl genrsa 2048 2>/dev/null)" GITHUB_API_URL=http://127.0.0.1:4011 \
npm run test:e2e
```

The GitHub stand-in (`test/e2e/mock-github.ts`) does not check signatures, so any throwaway RSA key will do.

## Proving it

```bash
npm test          # unit and database tests, as the restricted role, against real Postgres
```

What the suite pins for sign-in and access:

- `test/proxy.test.ts` — one host; exact Origin on state-changing requests; a signed-out page
  goes to sign-in on this host, never the login host, keeping its path; `/healthz` answers on
  any host.
- `test/portal-sign-in.test.ts` — the whole sign-in through its server actions: an invitation
  accepted, the authenticator set up, the emailed code never enough on its own, recovery codes
  once, the attempt limit, foreign Origins, service accounts, and handed-over sessions refused.
- `test/authorize.test.ts` — the central function's checks, one at a time, in order.
- `test/authorization-coverage.test.ts` — reads `app/` from disk and fails if a page, route or
  server action skips the central function, or a form lacks its CSRF field.
- `test/sign-in-boundary.test.ts` — as the restricted role: none of login.10xid.com's sign-in
  tables can be read or written.

The older browser suite here (`npm run test:e2e`) and `npm run prove` still sign in the way
they did before the login host existed, and need rewriting against this sign-in before they
can run again.

## Cutover

Moving `app.10xid.com` off login.10xid.com, in this order:

1. **`app` service:** set `TOTP_ENC_KEY` (`openssl rand -base64 32`; without it the service
   refuses to start) and remove `PRIMARY_HOST`. `RESEND_API_KEY` is already there for invitations.
2. **Clear the old authenticators**, so everybody sets one up fresh on first sign-in (the ones
   on login.10xid.com live in its own tables, which this app cannot read; any left in `users`
   are from before that, under another key). Login's migration `0051_portal_own_sign_in` does
   this when login deploys.
3. **Deploy** this branch. Every session handed over from the login host stops working; people
   sign in at `app.10xid.com/auth/sign-in`.
4. **`portal` service (login.10xid.com):** unset `PORTAL_HOST` and add `app.10xid.com` to
   `PORTAL_RETIRED_DOMAINS`, then redeploy, so it stops sending anyone here and its row in
   `organization_domains` is removed (login's README, "The portal is untied").

Until everybody has signed in once, a person's first sign-in is their emailed code followed by
setting up an authenticator — so in that window the inbox alone is enough to claim an account.
Ask people to sign in soon after the cutover.

## Lost authenticator

There is deliberately no button for it. An operator, as the database owner, clears it after
confirming who is asking, and the person sets up a new one at their next sign-in:

```sql
update users set totp_secret = null, totp_confirmed_at = null where email = '<address>';
update recovery_codes set used_at = now() where used_at is null
  and user_id = (select id from users where email = '<address>');
update sessions set revoked_at = now() where revoked_at is null
  and user_id = (select id from users where email = '<address>');
```

## Conventions worth knowing

- **Next.js 16 renamed middleware to `proxy.ts`.** It refuses any host but the app's, refuses
  a state-changing request from another origin, and sends a page with no session cookie to
  sign-in. It authorizes nothing: that is `lib/auth/authorize.ts`, called from every route.
- **Versions are pinned exactly.** Drizzle's documentation site describes 1.0 while npm
  installs 0.45.2 with a different migration layout, so a caret produces a build that
  does not match its own documentation.
- **Job ids in URLs are UUIDv7**, generated in application code because Postgres 16 has no
  native `uuidv7()`. The human reference (`ROT-0042`) is per-client sequential and never
  appears in a URL, since it would otherwise leak how many jobs a client has.
- **The hostname decides branding, never permission.** What a person may read comes from
  their session. The address bar carries no authority.
- **Sessions:** seven days from signing in at most, 48 hours idle, both enforced on the server.
  Revoking a membership takes effect on the next request, because every request asks the
  database.

## The decision record

`docs/portal-architecture.html` — cross-domain sign-in, sessions, tenancy, the data model,
DNS, phases, costs and risks, with the reasoning for each.

Published: <https://claude.ai/artifact/Vzzyh8w5Re9zafx7kef75G> (written before the build;
the session-lifetime section has since been revised in the repo copy).
