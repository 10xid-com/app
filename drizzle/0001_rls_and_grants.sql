-- Row-level security and role grants.
--
-- The application connects as a RESTRICTED role (portal_app) that does not own
-- these tables and holds neither SUPERUSER nor BYPASSRLS. That is not a detail:
-- Postgres silently ignores row-level security for superusers and for the table
-- owner, which is the single most common reason a tenant-isolation test passes
-- while providing no protection at all.
--
-- Migrations run as the owner, which DOES bypass these policies — that is
-- deliberate, so that seeds and migrations can write across organizations.
-- The application asserts at boot that its own connection is not privileged.

--> statement-breakpoint

-- The role the application connects as. Created here only if absent, so that
-- environments which provision it out of band (Railway, CI) are unaffected.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app') THEN
    CREATE ROLE portal_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO portal_app;

--> statement-breakpoint

-- Ordinary read/write on everything the application legitimately touches.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, organization_domains, users, memberships,
  sessions, sign_in_codes, sso_tickets, staff_grants, jobs
TO portal_app;

--> statement-breakpoint

-- The audit log is append-only, enforced by the database rather than by
-- convention: the application role is granted INSERT and SELECT and nothing
-- else, so an UPDATE or DELETE fails as a permission error.
GRANT SELECT, INSERT ON job_events TO portal_app;

--> statement-breakpoint

GRANT USAGE, SELECT ON SEQUENCE job_events_id_seq TO portal_app;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tenant isolation
--
-- The filter reads a per-request setting. `current_setting(..., true)` returns
-- NULL when the setting was never set, and NULLIF guards the empty string, so
-- an unscoped connection matches NO rows. It fails CLOSED: forgetting to scope
-- returns nothing rather than returning everything.
--
-- The setting MUST be applied transaction-locally (set_config(..., true)
-- inside a transaction). A session-level SET would persist on the pooled
-- connection and be inherited by the next request — possibly another tenant's —
-- and that failure mode leaks data rather than blocking it.
-- ---------------------------------------------------------------------------

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY jobs_tenant_isolation ON jobs
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY job_events_tenant_isolation ON job_events
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
