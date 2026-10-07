# 10XiD Portal — app

The portal at **`app.10xid.com`**: the dashboard, requests and jobs, and the team screen.
It answers on that host and **no other** — client domains get nothing from it and carry no
management cookie (Revision 2; Paolo's decision of 2026-10-07).

**Sign-in is WorkOS AuthKit**, through the official Next.js SDK, with one fixed callback at
`https://app.10xid.com/callback`. WorkOS answers *who signed in*; this database answers *what
they may do*, through one central authorization function (`lib/auth/authorize.ts`) that every
protected page, server action and route handler passes through. The schema and migrations
still live in [`10xid-com/login`](https://github.com/10xid-com/login).

Both apps use **one database**. `lib/db/schema.ts` here is a copy of login's, kept
identical by CI (`.github/workflows/database.yml`): a schema change is made in login, with
its migration, then copied here unchanged.

## What it does

- **Sign in with WorkOS** — one-time email code, Google, Microsoft or password, with an
  authenticator required for everybody (set in the WorkOS environment). The session cookie is
  host-only, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, and lasts seven days; startup
  refuses any other setting (`instrumentation.ts`).
- **An account is found by its WorkOS user id**, never by its address. A new person is created
  by accepting an invitation made out to exactly their verified address (seven days, once). An
  account from before WorkOS asks an operator on its first WorkOS sign-in and waits for
  confirmation (`identity_bindings`; the operator runs `npm run identity:bindings` in login).
- **Six role templates** — owner, manager, editor, publisher, asset manager, viewer. Until the
  permission matrix is written, owner holds every action and the other five hold none
  (`lib/auth/permissions.ts`).
- **Every state-changing request** needs the exact `https://app.10xid.com` Origin and a CSRF
  token bound to the WorkOS session.
- **Staff access is off.** The Clients, Keys, Act as and `/chat` screens are still in the code
  and refused to everybody, pending client-approved agency grants. WorkOS impersonation is
  refused too.
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

Needs Node 22+, PostgreSQL 16, a checkout of `10xid-com/login` next to this one (`../login`)
for the migrations, and a WorkOS **staging** environment whose redirects include
`http://app.portal-a.test:3001/callback`.

```bash
npm install
cp .env.example .env.local        # connection strings, and the WorkOS staging values with
                                  # NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://app.portal-a.test:3001/callback

# Database, from login (once, and after any schema change there):
(cd ../login && npm install && npm run db:migrate && npm run db:seed)

npm run dev -- -p 3001
```

Then open `http://app.portal-a.test:3001/` (with `127.0.0.1 app.portal-a.test` in
`/etc/hosts`). Any other host is answered with a 404, by design.

## Optional integrations

Each is **inert without configuration** rather than half-working. See `.env.example`.

| | What it needs |
|---|---|
| Email (Resend) | `RESEND_API_KEY`. Without it, development writes codes to a file and production refuses to start the flow. |
| Google Drive | A service account with the `drive.file` scope, and one folder shared with it. The scope reaches only files the portal itself created. |
| Optional alternate workspace engines (Claude, OpenAI) | `ANTHROPIC_API_KEY` for the Claude modes; `OPENAI_API_KEY` plus `OPENAI_MODEL_MULTIMODAL` / `OPENAI_MODEL_REVIEW` for the OpenAI modes. They remain in the repository but are not the stated Chat Boss provider intent. See "The workspace" below. |
| Ollama (prototype) | `ENABLE_PROTOTYPE_ENGINE=true` and `OLLAMA_API_KEY` for Ollama Cloud. One picker entry per model in `OLLAMA_MODELS`, plus Auto. Text only, no tools, house workspace only — unless `OLLAMA_CLOUD_CLIENT_DATA=true`, which gives it the job and repository tools and client workspaces. |
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

- `test/session-cookie.test.ts` — the SDK's real callback and refresh paths, with a request
  arriving as Railway delivers it (plain http), write the agreed cookie; startup refuses
  anything else.
- `test/proxy.test.ts` — one host; exact Origin on state-changing requests; signed-out pages go
  to WorkOS with PKCE and come back to the one callback.
- `test/authorize.test.ts` — the central function's checks, one at a time, in order.
- `test/authorization-coverage.test.ts` — reads `app/` from disk and fails if a page, route or
  server action skips the central function, or a form lacks its CSRF field.
- `test/sign-in.test.ts` — what a WorkOS sign-in means locally: invitation, operator binding,
  conflict, unverified address, stranger.

What only a deployed environment can show — the real `Set-Cookie`, an idle tab, a background
refresh, a phone — is the checklist in `docs/session-gate.md`.

The browser suite (`npm run test:e2e`) and `npm run prove` still sign in with the old emailed
codes and need rewriting against a WorkOS staging environment before they can run again.

## Conventions worth knowing

- **Next.js 16 renamed middleware to `proxy.ts`.** It refuses any host but the app's, refuses
  a state-changing request from another origin, and runs the WorkOS session refresh. It
  authorizes nothing: that is `lib/auth/authorize.ts`, called from every route.
- **The WorkOS SDK reads the cookie's `Secure` flag from the request URL**, which behind
  Railway's proxy is plain http. The callback and the proxy hand it the request re-addressed
  to `https://app.10xid.com` (`addressedToApp`); without that, the session cookie would be
  issued without `Secure`.
- **Versions are pinned exactly.** Drizzle's documentation site describes 1.0 while npm
  installs 0.45.2 with a different migration layout, so a caret produces a build that
  does not match its own documentation.
- **Job ids in URLs are UUIDv7**, generated in application code because Postgres 16 has no
  native `uuidv7()`. The human reference (`ROT-0042`) is per-client sequential and never
  appears in a URL, since it would otherwise leak how many jobs a client has.
- **The hostname decides branding, never permission.** What a person may read comes from
  their session. The address bar carries no authority.
- **Sessions are WorkOS's:** seven-day maximum, 48-hour refresh timeout, five-minute access
  token, set in the WorkOS dashboard. Revoking a membership takes effect on the next request,
  because every request asks the database.

## The decision record

`docs/portal-architecture.html` — cross-domain sign-in, sessions, tenancy, the data model,
DNS, phases, costs and risks, with the reasoning for each.

Published: <https://claude.ai/artifact/Vzzyh8w5Re9zafx7kef75G> (written before the build;
the session-lifetime section has since been revised in the repo copy).
