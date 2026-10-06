# Database-backed CI Security Gate Design

Status: design approved for implementation planning only. No workflow changes are made by this document.

## Goal

Add a database-backed CI gate that proves the repository can migrate a brand-new PostgreSQL database, create and use the restricted `portal_app` role, preserve the intended grants/RLS model, load deterministic test fixtures, and pass the existing Vitest isolation/security suite.

The CI database must be disposable and local to the GitHub Actions runner. Railway and the certified Neon databases must never be CI targets.

## Repository facts this design is based on

### Migration and role model

- `scripts/migrate.mjs` runs with `DATABASE_URL` as the database owner.
- Migration `0001_rls_and_grants.sql` creates `portal_app` if it does not already exist as:
  - LOGIN
  - NOSUPERUSER
  - NOBYPASSRLS
  - NOCREATEDB
  - NOCREATEROLE
- `0001` grants schema usage plus application table privileges, enables RLS on the first tenant tables, and creates policies bound to `portal_app`.
- Later migrations extend grants/RLS to API keys, invitations, departments/permissions, Flow tables, workspace/chat tables, and repositories.
- Append-only tables intentionally receive narrower grants, for example `job_events`, `task_events`, conversation messages, and agent run receipts.
- Current migrations do not use FORCE ROW LEVEL SECURITY.
- `scripts/migrate.mjs` sets the `portal_app` password from `PORTAL_APP_PASSWORD` after migrations. It does not bootstrap accounts unless `BOOTSTRAP_EMAIL` is set.
- Current repository migrations include historical data-writing migrations, notably `0012_flow_clients_and_accounts.sql`, plus later reconciliation/data migrations. That makes migration replay unsuitable for reconstructing the Railway source, but it is appropriate for testing whether a fresh database can be created from the repository as it exists today.

### Test fixture model

- `scripts/seed.ts` runs as the owner and truncates the application fixture spine, including organizations, users, memberships, sessions, sign-in state, grants, jobs, and job events, with `CASCADE`.
- It then creates deterministic test identities and two client organizations:
  - Rotary
  - Northstar Roofing
  plus the internal Branding Centres organization.
- It creates both Rotary and Northstar jobs specifically so cross-tenant isolation can be tested.
- Because `db:seed` runs after migrations, migration-authored account/client rows are removed before the Vitest suite begins. Seed data, not migration-authored customer/account data, becomes the CI fixture baseline.
- Migration-owned reference rows that are not part of the fixture truncation, such as task time bands, remain available as schema/reference data.

### Vitest prerequisites

- `test/setup.ts` fails immediately unless both `DATABASE_URL` and `DATABASE_APP_URL` are present.
- `DATABASE_URL` is intentionally privileged and is used for fixtures/inspection.
- `DATABASE_APP_URL` must connect directly as the restricted `portal_app` role.
- `vitest.config.mts` sets `fileParallelism: false` because test files share one database and may mutate fixture state.
- Isolation tests directly assert that `portal_app`:
  - is not superuser
  - has no BYPASSRLS
  - owns none of the protected tenant tables
  - sees zero tenant rows without scope
  - cannot read another tenant by exact ID
  - cannot write across tenants
  - cannot alter append-only audit data
  - does not leak transaction-local scope between transactions
- Workspace isolation additionally tests organization + user ownership and database-enforced immutability/constraints.

### Existing security scripts

- `npm run db:rls-check` executes `scripts/check-rls.ts`.
- It enumerates public tables carrying organization identifiers and requires each to be either RLS-protected or explicitly exempted with a written reason.
- It fails if a required protected table is absent, lacks RLS, or has zero policies.
- `npm run prove` is a browser-backed live URL-guessing proof. It mutates sign-in state and depends on browser/runtime assumptions. It should not be part of the first database CI implementation.
- Playwright E2E also uses shared mutable DB state and a `next dev` server. It should be a later isolated browser gate, not bundled into the first PostgreSQL gate.

## Concrete CI architecture

Use a GitHub Actions PostgreSQL **service container**, pinned to PostgreSQL major 18 to match the current Railway/Neon major version.

The service exists only for the lifetime of one GitHub Actions job.

Proposed local-only database identity:

```text
host: 127.0.0.1
port: 5432
database: portal_ci
owner role: ci_owner
restricted role: portal_app
```

The owner/service-container password and `portal_app` password are throwaway CI-only values. They are not production secrets and must never be sourced from GitHub production secrets, Railway, Neon, Vercel, or any external secret store.

The resulting runner-side connections are conceptually:

```text
DATABASE_URL=postgresql://ci_owner:<throwaway>@127.0.0.1:5432/portal_ci
DATABASE_APP_URL=postgresql://portal_app:<throwaway>@127.0.0.1:5432/portal_ci
```

No remote hostname is permitted in either connection URL.

### Docker service identity contract

GitHub-hosted jobs reach a PostgreSQL service container through a runner-side localhost port mapping. PostgreSQL itself reports the container-side address from `inet_server_addr()`, not runner loopback.

The guard canonicalizes PostgreSQL's `inet` value with `host(inet_server_addr())` before comparison. This is load-bearing: casting an `inet` directly to text may include a netmask suffix (for example `/32`), which is not the same representation as Docker's bare IP literal even when both identify the same interface.

The workflow must derive the exact running PostgreSQL service-container address from the specific service container instance and pass only that exact IP literal as:

```text
CI_DB_EXPECTED_SERVER_ADDR=<exact service-container IP>
```

The integration contract is:

1. keep `DATABASE_URL` and `DATABASE_APP_URL` pinned to runner loopback (`127.0.0.1:5432`);
2. obtain the PostgreSQL service container ID from `job.services.postgres.id`;
3. require one exact 64-hex Docker container id;
4. inspect that exact container and require it to be running with image `postgres:18`;
5. extract exactly one non-empty service-network IPv4 address from that container;
6. fail if the container identity or address is missing, malformed, or ambiguous;
7. export that one address as `CI_DB_EXPECTED_SERVER_ADDR`;
8. the guard requires canonical `host(inet_server_addr())` to equal it byte-for-byte for both owner and restricted-role connections.

This does **not** allow arbitrary RFC1918/private address ranges, CIDRs, or hostnames. An arbitrary private IP is rejected unless it is the exact address derived from the current PostgreSQL service instance.

## Fail-closed target guard

Before **any migration, seed, truncate, or test command**, add a repository script dedicated to CI target verification, proposed path:

```text
scripts/ci-db-guard.mjs
```

It must parse and validate `DATABASE_URL` and, when present, `DATABASE_APP_URL`.

The guard must fail unless all applicable assertions are true:

1. hostname is exactly `127.0.0.1` or `localhost`;
2. database name is exactly `portal_ci`;
3. owner URL username is exactly `ci_owner`;
4. app URL username is exactly `portal_app`;
5. both URLs point to the same host/port/database;
6. neither URL contains a Railway, Neon, Vercel, or other remote host;
7. `CI_DB_EXPECTED_SERVER_ADDR` exists and is exactly one IPv4 or IPv6 literal derived from the current PostgreSQL service container instance;
8. a live owner connection reports:
   - `current_database() = 'portal_ci'`
   - `current_user = 'ci_owner'`
   - `session_user = 'ci_owner'`
   - `inet_server_addr()` exactly equals `CI_DB_EXPECTED_SERVER_ADDR`
   - server port is 5432;
9. after migration, a live app connection reports:
   - `current_user = 'portal_app'`
   - `rolsuper = false`
   - `rolbypassrls = false`
   - `rolcreatedb = false`
   - `rolcreaterole = false`
   - `rolreplication = false`
   - `inet_server_addr()` exactly equals `CI_DB_EXPECTED_SERVER_ADDR`
   - zero ownership of the CI database and application schemas/relations/routines/enums/domains
   - no direct or transitive role memberships.

The guard should have two explicit modes:

```text
pre-migrate
post-migrate
```

`pre-migrate` verifies the disposable owner target before the first write.

`post-migrate` additionally verifies `portal_app` and owner separation before seed/tests.

A malformed, missing, nonlocal, unexpected, or privileged app target must exit non-zero before tests run.

This guard is defense in depth. The workflow itself must also construct the URLs locally rather than reading database URLs from repository or organization secrets.

## Migration setup

Run the production migration entry point because it exercises the path used by deployment:

```text
npm run db:migrate:prod
```

Environment rules for this step:

- set `DATABASE_URL` to the local `ci_owner` connection;
- set `PORTAL_APP_PASSWORD` to the throwaway local CI password;
- explicitly leave `BOOTSTRAP_EMAIL`, `BOOTSTRAP_CLIENT_EMAIL`, and `PORTAL_CLIENT_DOMAINS` unset;
- do not provide `DATABASE_APP_URL` until the role has been created/configured, unless the guard implementation benefits from having the expected URL present but not connecting to it in pre-migrate mode.

Expected effect:

- all repository migrations apply to the blank disposable database;
- `portal_app` is created by migration 0001;
- grants and RLS policies are created by migrations;
- `scripts/migrate.mjs` assigns the throwaway local password to `portal_app`;
- historical data migrations may create rows temporarily, but they never leave CI or touch an external database.

## Safe fixture setup

After successful migration and post-migration role verification:

```text
npm run db:seed
```

The seed uses only `DATABASE_URL` and intentionally truncates/replaces the application fixture dataset.

This is the correct CI fixture boundary because:

- it removes account/client rows authored by historical migrations;
- it creates the exact identities and tenant rows the isolation suite expects;
- the database is disposable, so truncation is harmless;
- no production or certified-copy data is present.

Do not import the Railway dump or any Neon data into CI.

## First database-backed gate: exact check order

The first implementation should run in this order:

1. start PostgreSQL 18 service container;
2. wait for PostgreSQL health check;
3. `npm ci`;
4. construct only local throwaway owner/app URLs;
5. verify the exact GitHub Actions PostgreSQL service container (64-hex container id, running `postgres:18`), extract exactly one service-network IPv4 address, and export it as `CI_DB_EXPECTED_SERVER_ADDR`;
6. run `ci-db-guard.mjs pre-migrate`;
7. run `npm run db:migrate:prod`;
8. run `ci-db-guard.mjs post-migrate`;
9. run `npm run db:seed`;
10. run `npm run db:rls-check`;
11. run `npm test`;
12. optional final read-only guard/report confirming `portal_app` remained restricted.

Each step stops the job immediately on failure.

### Why this order

- Target verification occurs before any destructive command.
- Migration proves a fresh repository checkout can construct the DB and role model.
- Role verification happens before fixtures or tests can give false confidence under a privileged connection.
- Seed establishes the deterministic two-tenant fixture baseline.
- The metadata/RLS check fails cheaply before the larger Vitest suite.
- Vitest then exercises both direct PostgreSQL behavior and application-layer behavior.

## What is deliberately excluded from v1

The first database-backed gate should **not** include:

- `npm run prove`
- Playwright E2E
- external AI provider calls
- GitHub App calls
- Drive calls
- Railway
- Neon
- Vercel
- production credentials
- production dumps

Browser proofs can become a separate later job after browser installation, hostname routing, code-sink behavior, and fixture reset are designed for GitHub-hosted runners.

## Cleanup

The PostgreSQL service container is the cleanup boundary.

GitHub Actions destroys the job container/network and PostgreSQL service when the job ends, including on test failure or cancellation. Therefore:

- no persistent database survives the job;
- no cleanup credentials are needed;
- no remote database needs DROP/TRUNCATE cleanup;
- cleanup cannot accidentally target Railway/Neon because they are never configured.

An `if: always()` diagnostic step may print only non-sensitive facts such as:

- database name;
- current roles;
- count of public tables;
- count of RLS policies;
- test exit status/artifact names.

It must not print connection URLs or passwords.

Do not rely on an explicit `DROP DATABASE` as the safety mechanism; container destruction is stronger and simpler.

## Failure handling

Driver/connection/query errors are sanitized by the guard. Raw node-postgres error messages are not printed because they may contain host/user/database details or, depending on caller/driver behavior, credential-bearing connection material. The guard emits only fixed safe failure categories.


Every database-writing step must run only after the local-target guard succeeds.

Failure behavior:

- health check failure -> job fails; no migration;
- pre-migrate guard failure -> job fails before any DB write;
- migration failure -> job fails; no seed/tests;
- post-migrate role/ownership failure -> job fails before seed/tests;
- seed failure -> job fails; no security assertions are accepted;
- RLS check failure -> job fails before Vitest;
- Vitest failure -> database-security gate is red;
- cancellation -> service container is destroyed automatically.

No retry should silently rebuild against another target. A rerun gets a new blank service container.

## Public-repository GitHub security posture

Because the repository is public, the database gate must be safe for untrusted pull-request code.

Required workflow posture:

- trigger on `pull_request` and optionally push to `main`;
- **never** use `pull_request_target` for this job;
- permissions must remain:
  ```yaml
  permissions:
    contents: read
  ```
- do not grant write permissions to contents, pull requests, checks, packages, deployments, actions, or id-token;
- do not expose production/repository/environment secrets;
- do not use Railway/Neon/Vercel connection strings as Actions secrets for this job;
- all DB passwords are disposable local test values, not secrets with external value;
- do not run external deployment, billing, DNS, database-provider, or infrastructure actions;
- checkout executes the PR's code only against the throwaway service container and GitHub-hosted runner;
- artifacts, if later enabled, must exclude `.env*`, URLs with credentials, DB dumps, cookies, sign-in codes, and provider tokens.

A fork PR therefore receives no useful credential and can only reach the disposable local database created for its own job, subject to normal GitHub-hosted runner network policy.

## Relationship to branch protection

The existing `quality` check is required on `main` for non-bypass merge paths.

The database gate should initially be added and observed until it is stable. After successful validation, a separate explicit action can add its status check to branch protection.

Administrator bypass remains allowed under the current branch rule, so even after adding the database gate as required, enforcement must not be described as universal.

## Proposed job/check identity

Use a stable job name so branch protection can target it later, for example:

```text
database-security
```

The corresponding displayed check should remain stable across workflow edits.

## Acceptance criteria for the first implementation

The implementation is acceptable only when a public-repository PR run proves all of the following without external secrets:

- PostgreSQL 18 service is local and disposable;
- runner connection URLs are loopback-only and the live PostgreSQL server identity exactly matches the address derived from the current service-container instance;
- all migrations apply successfully;
- `portal_app` connects directly and is restricted/non-owner/non-BYPASSRLS;
- deterministic seed succeeds;
- `npm run db:rls-check` passes;
- `npm test` passes;
- no external DB/provider credential is available to the job;
- job cleanup leaves no persistent database;
- Railway, certified Neon copies, production app, DNS, and billing are unchanged.

## Exact next implementation step

Resolve and merge the guard PR only after the guard is verified against the documented Docker topology contract. The next separate implementation step after merge is to add the PostgreSQL 18 `database-security` service-container job on a new feature branch/PR. That workflow must derive `CI_DB_EXPECTED_SERVER_ADDR` from the exact running PostgreSQL service container before invoking the guard, then run migration/seed/security tests in the documented order.
