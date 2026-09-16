-- Staff read across clients — as an explicit, visible database policy rather
-- than a service key that switches all the rules off.
--
-- The brief requires staff to see every client. The existing storefront meets
-- that requirement with a service-role connection, which bypasses row-level
-- security entirely and produces two code paths: the ordinary one, and a
-- less-travelled admin one that is where the bugs live.
--
-- Instead, staff reads stay on the SAME connection, the SAME role and the SAME
-- query shape as everyone else. What changes is one additional policy, written
-- down here where it can be read and audited:
--
--   * SELECT only. Staff can survey every client's jobs.
--   * Writing still requires a scoped grant to one client, because the existing
--     tenant policy's WITH CHECK is the only thing that admits an INSERT or
--     UPDATE, and it demands app.org_id.
--   * The flag is transaction-local, set by the data access layer solely from
--     the session's stored role — never from a request header, a hostname, or
--     anything else the caller controls.
--
-- Postgres combines multiple permissive policies with OR, so this widens SELECT
-- for staff without weakening the tenant rule for anyone else.

--> statement-breakpoint

CREATE POLICY jobs_staff_read ON jobs
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');

--> statement-breakpoint

CREATE POLICY job_events_staff_read ON job_events
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');
