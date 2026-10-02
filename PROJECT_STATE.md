# PROJECT_STATE

## Current phase
Phase 1 — Platform Hardening

## Current action
Phase 1 / Recoverability — post-migration Neon baseline captured. Migration replay is now rejected as the copy strategy because the target journal hashes differ from the Railway source journal and committed migrations injected target-only application rows. Next step is prepare a source-authoritative logical dump/restore plan without touching Railway.

## Last passed checkpoint
Phase 1 recoverability checkpoint: Neon post-migration baseline captured. All 35 public tables exist with expected RLS flags/policies, but migration-authored rows are present and the Neon Drizzle journal hashes differ from the Railway source journal for many migration IDs.

## Confirmed findings
- Existing `/chat` implementation is the approved Chat Boss foundation.
- Do not introduce a second chat/agent architecture.
- Do not install AI SDK, AI Elements, Redis, object storage, a new auth system, or another database architecture unless specifically approved later.
- Current source database is Railway Postgres and remains the source of truth until a copied Neon database passes full re-certification.
- Railway workspace is on Hobby; native Railway Backups/PITR require Pro.
- Paolo explicitly rejected upgrading Railway to Pro for recoverability.
- Paolo explicitly approved Vercel Pro + Neon as the Phase 1 recoverability path.
- The current Railway database is approximately 10 MB (10,843,839 bytes).
- Vercel team is already on Pro.
- Vercel does not provide first-party Postgres; Neon is the approved Marketplace database target.
- The migration must be treated as a database migration, not a hosting switch.
- Railway source must remain untouched during migration and certification.
- No app production variables, DNS, or Railway resources may be changed or deleted before approval/cutover.
- Existing PostgreSQL security model depends on restricted app role `portal_app`, owner separation, grants, RLS policies, and transaction-local tenant context.
- Existing live Railway app role is not superuser, has no BYPASSRLS, and owns zero public tables.
- Existing tenant isolation and workspace isolation tests are substantial and must be rerun against Neon before cutover.
- Current Railway database has no backups/PITR.
- Railway source baseline captured from PostgreSQL 18.6, database size 10,843,839 bytes, with 35 public tables, 20 Drizzle migration records, current table row counts, role attributes, ownership, grants, RLS flags, and 27 RLS policies.
- All public tables are currently owned by `postgres`; `portal_app` remains non-superuser and non-BYPASSRLS.
- Current baseline shows 2 rows in `permissions` (Phase 0 earlier observed 0), so the source dataset changed between checkpoints; the new baseline is authoritative for migration certification.
- Existing GitHub App credential in staging is malformed and remains a later Phase 1 item.
- Current staff account has confirmed TOTP but no recovery codes; current UI can provision them later.
- Current staff base sessions use a 400-day/no-idle policy; review is required later in Phase 1.

## Blockers
- Neon target currently contains migration-authored application rows; source data must not be imported on top of them until a safe reset/import sequence is selected.
- Current repo migration hashes do not match the Railway source migration journal, so migration replay is not a source-faithful reconstruction method.
- No source database backup exists today.
- Neon target role/ownership model has been partially inspected. `neondb_owner` is non-superuser but has BYPASSRLS and CREATEROLE; database owner is `neondb_owner`; `public` schema owner is `pg_database_owner`.
- Neon successfully created a transactional test login role matching the intended app-role attributes: NOSUPERUSER, NOBYPASSRLS, LOGIN, NOCREATEDB, NOCREATEROLE. The transaction rollback removed the role, confirming no persistent change.
- `neondb_owner` does not automatically have SET ROLE permission to a role it creates. An explicit membership grant is required for SQL-editor impersonation tests; this is a test-harness detail, not an app-runtime requirement because the app will connect directly as the restricted role.
- Neon successfully preserved transaction-local custom settings `app.org_id`, `app.user_id`, and `app.is_staff` while running as a restricted role. After rollback, the settings were empty and the temporary role no longer existed.
- Neon successfully enforced an RLS policy bound to `app.org_id` under a restricted app-like role: one same-tenant row visible, cross-tenant row count zero; rollback removed all test objects.
- Applying repository migrations to an empty Neon database is not schema-only. Migration 0012 contains committed application data and creates up to 8 organizations, 8 users, and 8 memberships; later migrations audit/reconcile some of that data. Therefore a naïve source data import onto the migrated target risks uniqueness/PK conflicts and must not proceed until target state is baselined and the copy method is adjusted.
- Neon post-migration counts include organizations=8, users=8, user_emails=8, memberships=8, permissions=1, task_time_bands=3, while most other tables are empty.
- The Neon migration journal contains 20 entries, but its hashes differ from the Railway source journal for many IDs (for example IDs 1-3 and 5-20). This proves the repository migration files have changed since the Railway database originally applied them. Replaying current migrations cannot be used to reconstruct the Railway source exactly.
- No migration copy or restore drill has yet been performed.
- Neon role/ownership/grant/RLS compatibility has not yet been re-certified.

## Architecture decisions awaiting Paolo
- None for the database platform choice: Paolo approved Vercel Pro + Neon.
- Any change to RLS behaviour such as FORCE ROW LEVEL SECURITY still requires a later recommendation and approval.
- Any production/staging environment creation or cutover plan still requires approval before resource changes.
- Any session-policy change still requires approval.

## Migration acceptance criteria before any cutover
The copied Neon database must pass:
1. restore/recovery demonstration on a separate branch/database,
2. migration-history verification,
3. schema verification,
4. source-vs-target row-count verification,
5. role/ownership/grant verification,
6. RLS and policy verification,
7. transaction-local tenant-context verification,
8. application/database isolation tests.

## Next action
Prepare and validate a logical dump command against the Railway source that captures schema, data, policies, grants, sequences, functions, triggers, and the Drizzle journal while excluding role passwords/secrets and without changing the source. Do not restore it yet.
