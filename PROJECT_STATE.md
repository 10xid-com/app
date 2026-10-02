# PROJECT_STATE

## Current phase
Phase 1 — Platform Hardening

## Current action
Phase 1 / Recoverability — Neon ownership model inspected; next step is verify whether Neon can reproduce the restricted `portal_app` role semantics before any schema/data import.

## Last passed checkpoint
Phase 1 recoverability checkpoint: Neon owner role inspected. `neondb_owner` is not superuser, but has BYPASSRLS, LOGIN, CREATEDB, and CREATEROLE; database owner is `neondb_owner`; `public` schema owner is `pg_database_owner`.

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
- No source database backup exists today.
- Neon target role/ownership model has been partially inspected. `neondb_owner` is non-superuser but has BYPASSRLS and CREATEROLE; database owner is `neondb_owner`; `public` schema owner is `pg_database_owner`. Restricted app-role compatibility still needs proof.
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
Use the Neon SQL Editor to verify whether a non-BYPASSRLS, non-superuser login role can be created without importing schema/data. Do not grant table privileges or import anything yet.
