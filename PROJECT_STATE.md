# PROJECT_STATE

## Current phase
Phase 1 — Platform Hardening

## Current action
Phase 1 / Recoverability — prepare controlled Railway Postgres → Neon migration plan and source-state capture before provisioning or copying data.

## Last passed checkpoint
Phase 0 complete — PASS WITH ISSUES.

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
- Existing GitHub App credential in staging is malformed and remains a later Phase 1 item.
- Current staff account has confirmed TOTP but no recovery codes; current UI can provision them later.
- Current staff base sessions use a 400-day/no-idle policy; review is required later in Phase 1.

## Blockers
- Neon target is not yet provisioned.
- No source database backup exists today.
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
Capture an immutable read-only source baseline from Railway Postgres: Postgres version, database/schema sizes, migration journal, table inventory, row counts, role attributes, table ownership, grants, RLS flags, and policies. This baseline will be used to certify the Neon copy.
