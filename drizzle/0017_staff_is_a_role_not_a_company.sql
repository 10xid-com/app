-- STAFF IS A ROLE, NOT A COMPANY.
--
-- lib/auth/session.ts derived a session's role like this:
--
--   const role: SessionRole = mships.some((m) => m.organizationType === "internal")
--     ? "staff" : "client";
--
-- So being ADDED to the internal company was staff over every client's data.
-- A bookkeeper, a summer student, an account made to test something — anybody
-- put in the house held the cross-client survey and every client's jobs. The
-- `staff` value in the membership_role enum existed the whole time and decided
-- nothing, which is the worst arrangement of the two: the field that looks like
-- it answers the question does not, so reading the table tells you the wrong
-- thing.
--
-- 0013 found the live proof and named him: peter@tboxstudio.com, an
-- administrator who does the books, holding `tbox-studio:member:internal` and a
-- staff session. One account, and the audit says exactly one.
--
-- The companion change to lib/auth/session.ts now requires BOTH halves — an
-- internal company AND a membership role of `staff` — through one function,
-- sessionRoleFor() in lib/auth/policy.ts, used by startSession() and by
-- getSessionContext() so the two cannot drift apart. lib/db/invitations.ts,
-- which is the same defect at the other end (`isStaff = org?.type ===
-- "internal"`, written at the moment an account is created), now asks that same
-- function.
--
-- WHAT THIS FILE DOES ABOUT THE STORED FLAG.
--
-- users.is_staff is a denormalised COPY of the fact the session derives, in the
-- same bargain users.email makes with the primary address. A copy can disagree
-- with the thing it copies, and this one did: 0013 reported Peter as is_staff
-- true with no staff-role membership anywhere. Two blocks, in order:
--
--   1. A TRIGGER, so the two cannot disagree by accident again. Every INSERT,
--      UPDATE or DELETE on `memberships`, and every change of `organizations.
--      type` or `organizations.deleted_at`, recomputes users.is_staff for the
--      people affected, by the same rule the session uses. Membership changes
--      are the only things that can legitimately change the answer, and none of
--      them went anywhere near this flag before — it was written once, at
--      account creation, and never revisited. That is why Peter's was wrong.
--
--   2. A RECONCILIATION, once, for the rows that are already wrong. Reported
--      per account, with addresses, because these are exactly the security
--      critical rows 0013 was written to show.
--
-- AND THE SESSIONS THAT ARE ALREADY LIVE, which is the one thing the code
-- change cannot reach. A session's role is stamped on its row at creation and
-- sessions no longer expire on their own, so without block 5 the person who
-- stops being staff here would go on holding a staff session for up to four
-- hundred days. See that block for why revoking is the smallest honest answer.
--
-- WHAT THE TRIGGER CANNOT DO, said plainly rather than left to be discovered:
-- a direct `UPDATE users SET is_staff = ...` is not intercepted, so the flag
-- can still be set by hand to something the memberships do not support. That is
-- deliberate. Making the column fully derived would mean overwriting whatever a
-- caller wrote, which is a surprising thing for a column to do, and
-- test/act-as.ts pins behaviour that depends on drift being POSSIBLE — because
-- the one place the flag is still read for a decision, lib/auth/act-as.ts, ORs
-- it with the membership derivation. Either being true costs an extra
-- permission; neither can skip a check. So the remaining disagreement can only
-- ever make the system more careful, never less.
--
-- WHY THE FLAG IS NOT SIMPLY DELETED. It is read in three places and only one
-- of them is a decision: the act-as gate above (OR'd, defence in depth), the
-- "staff" badge in the act-as picker, and the team list. Dropping a column on a
-- live database to remove a defence-in-depth check is a bigger change than this
-- one, and it belongs in its own file if anybody wants it.
--
-- NOBODY GAINS ACCESS HERE. The reconciliation can only bring the flag into
-- line with the memberships, and 0013 reported 0 accounts holding a staff-role
-- membership while is_staff was false — so on production this direction is
-- empty and the only movement is Peter losing a flag that was never earned.
--
-- REPLAYABLE THROUGHOUT, like 0012, 0014 and 0015: CREATE OR REPLACE for the
-- functions, DROP TRIGGER IF EXISTS before each CREATE TRIGGER, and a
-- reconciliation that is a no-op the second time by construction — it only
-- touches rows where the flag and the derivation differ, and after the first
-- run there are none. A second run says so.

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. The rule, in one function.
--
-- Takes the people to recompute rather than recomputing everybody, so an
-- ordinary membership insert costs one indexed lookup and not a table scan.
--
-- The predicate is sessionRoleFor()/isStaffMembership() in SQL, clause for
-- clause: role `staff`, company type `internal`, company not deleted. The
-- deleted_at test is there because membershipsForUser() filters deleted
-- companies out, so a flag that counted them would disagree with the session
-- about a company nobody can see any more.
--
-- IS DISTINCT FROM, not <>, and the UPDATE is filtered by it: a recompute that
-- lands on the value already stored writes no row at all, so this does not
-- churn updated_at or wake any other trigger on `users` for nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity_sync_is_staff(p_user_ids uuid[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_user_ids IS NULL OR cardinality(p_user_ids) = 0 THEN
    RETURN;
  END IF;

  UPDATE users u
     SET is_staff = d.derived,
         updated_at = now()
    FROM (
      SELECT x.id,
             EXISTS (
               SELECT 1
                 FROM memberships m
                 JOIN organizations o ON o.id = m.organization_id
                WHERE m.user_id = x.id
                  AND m.role    = 'staff'
                  AND o.type    = 'internal'
                  AND o.deleted_at IS NULL
             ) AS derived
        FROM unnest(p_user_ids) AS x(id)
    ) d
   WHERE u.id = d.id
     AND u.is_staff IS DISTINCT FROM d.derived;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Membership changes.
--
-- An UPDATE can move a membership from one person to another, so both the old
-- and the new user are recomputed; recomputing only NEW would leave the person
-- the row was taken away from carrying a flag they no longer support.
--
-- AFTER, and returns NULL: this is a side effect on another table, not an
-- amendment of the row being written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity_is_staff_after_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP <> 'INSERT' THEN v_ids := v_ids || OLD.user_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_ids := v_ids || NEW.user_id; END IF;
  PERFORM identity_sync_is_staff(v_ids);
  RETURN NULL;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS memberships_sync_is_staff ON memberships;

--> statement-breakpoint

CREATE TRIGGER memberships_sync_is_staff
AFTER INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW EXECUTE FUNCTION identity_is_staff_after_membership();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The company changing type, or being deleted.
--
-- This is the other half, and 0016 is exactly why it is needed: retyping
-- `branding-centres` from internal to client changes who is staff without one
-- membership row moving. Everybody in the company is recomputed.
--
-- Scoped by the WHEN clause to the two columns that can change the answer, so
-- renaming a company or bumping its job counter does not walk its membership
-- list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity_is_staff_after_organization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT m.user_id), ARRAY[]::uuid[])
    INTO v_ids
    FROM memberships m
   WHERE m.organization_id = NEW.id;

  PERFORM identity_sync_is_staff(v_ids);
  RETURN NULL;
END
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS organizations_sync_is_staff ON organizations;

--> statement-breakpoint

CREATE TRIGGER organizations_sync_is_staff
AFTER UPDATE OF type, deleted_at ON organizations
FOR EACH ROW
WHEN (OLD.type IS DISTINCT FROM NEW.type
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION identity_is_staff_after_organization();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The rows that are already wrong.
--
-- Reported before it writes, per account, with addresses. These are the same
-- rows 0013 printed in full for the same reason: the set is expected to be tiny
-- and each member of it is a person who does or does not hold authority over
-- every client. A ceiling degrades to ids if the set turns out not to be tiny,
-- which is itself the finding — copied from 0013 so that a surprise cannot dump
-- a large number of addresses into a deploy log.
--
-- Both directions are named separately, because they are not the same news:
--
--   LOSES  is_staff true, no staff-role membership of the house. 0013 counted
--          one on production and named him. This is the intended outcome.
--   GAINS  a staff-role membership of the house while is_staff was false. 0013
--          counted ZERO of these, so this should print nothing at all — it is
--          here because a silent correction in that direction would be the one
--          worth knowing about, and "expected to be empty" is not a reason to
--          look away.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r          record;
  v_loses    int;
  v_gains    int;
  v_named    boolean;
  v_changed  int;
  c_ceiling  constant int := 25;
BEGIN
  RAISE NOTICE '[staff] ======== users.is_staff vs the membership rule ========';

  SELECT count(*) FILTER (WHERE u.is_staff AND NOT d.derived),
         count(*) FILTER (WHERE NOT u.is_staff AND d.derived)
    INTO v_loses, v_gains
    FROM users u
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM memberships m
          JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = u.id AND m.role = 'staff'
           AND o.type = 'internal' AND o.deleted_at IS NULL
      ) AS derived
    ) d
   WHERE u.is_staff IS DISTINCT FROM d.derived;

  IF v_loses + v_gains = 0 THEN
    RAISE NOTICE '[staff] Nothing to reconcile: every account''s is_staff already matches its memberships. Nothing written.';
    RETURN;
  END IF;

  v_named := (v_loses + v_gains) <= c_ceiling;
  IF NOT v_named THEN
    RAISE NOTICE '[staff] % account(s) disagree — more than the ceiling of %, so ids only. That count is itself the finding.', v_loses + v_gains, c_ceiling;
  END IF;

  FOR r IN
    SELECT u.id, u.email, u.is_staff, u.is_service, u.deleted_at, d.derived,
           (SELECT string_agg(o.slug || ':' || m.role::text || ':' || o.type::text, ', ' ORDER BY o.slug)
              FROM memberships m
              JOIN organizations o ON o.id = m.organization_id
             WHERE m.user_id = u.id) AS held
      FROM users u
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM memberships m
            JOIN organizations o ON o.id = m.organization_id
           WHERE m.user_id = u.id AND m.role = 'staff'
             AND o.type = 'internal' AND o.deleted_at IS NULL
        ) AS derived
      ) d
     WHERE u.is_staff IS DISTINCT FROM d.derived
     ORDER BY u.email
  LOOP
    RAISE NOTICE '[staff] % % is_staff % -> %  holds: %',
      CASE WHEN r.derived THEN 'GAINS ' ELSE 'LOSES ' END,
      CASE WHEN v_named THEN rpad(r.email, 34) ELSE r.id::text END,
      r.is_staff,
      r.derived,
      COALESCE(r.held, '(no memberships at all)')
      || CASE WHEN r.is_service THEN '  [service account]' ELSE '' END
      || CASE WHEN r.deleted_at IS NOT NULL THEN '  [DELETED]' ELSE '' END;
  END LOOP;

  -- The write, through the same function the triggers call, so the one-off
  -- correction and every future correction cannot be two different rules.
  SELECT count(*) INTO v_changed FROM users;
  PERFORM identity_sync_is_staff(ARRAY(SELECT id FROM users));

  RAISE NOTICE '[staff] RECONCILED     % account(s) lost the flag, % gained it, out of % examined.', v_loses, v_gains, v_changed;
  RAISE NOTICE '[staff] Nobody gained ACCESS here: the flag follows the memberships, and no membership was changed by this file.';
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. The sessions that are already live.
--
-- THIS IS THE ONE THING THE CODE CHANGE ALONE DOES NOT REACH, and leaving it
-- out would have made the whole exercise take effect "eventually".
--
-- A session's role is STAMPED ON THE ROW at creation — `role_at_creation` —
-- and getSessionContext() reads it back rather than recomputing it per
-- request. That is deliberate and documented in lib/auth/policy.ts: a session
-- carries the policy it was created under, so promoting somebody tomorrow does
-- not retroactively stretch a session that is already live, and demoting them
-- does not silently extend one. Sessions also no longer expire on their own —
-- 400 days is the browser's cookie ceiling, not a policy.
--
-- Put together, those two facts mean Peter's live session would go on being a
-- staff session for up to four hundred days after this deploy, with the new
-- rule in force and disagreeing with it the whole time. An authentication fix
-- that takes effect at the next sign-in is not a fix; it is a plan.
--
-- So: every LIVE session whose stamped role is `staff`, held by an account
-- that does not derive staff under the new rule, is revoked. Revoking is what
-- the Sessions screen does and what signOutEverywhere() does — a timestamp, on
-- the next request the row is not live and the person is signed out. They sign
-- in again and get the session they should have had, with no loss of anything
-- but the tab they had open.
--
-- NOBODY ELSE IS TOUCHED. Not client sessions, not staff sessions held by
-- people who still qualify, not sessions that are already revoked or already
-- past their absolute expiry. Idempotent by construction: after the first run
-- there is nothing live left to match.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r       record;
  v_n     int := 0;
  v_rows  int;
BEGIN
  RAISE NOTICE '[staff] ======== LIVE SESSIONS STAMPED staff ========';

  FOR r IN
    SELECT u.email, count(*) AS n
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.role_at_creation = 'staff'
       AND s.revoked_at IS NULL
       AND s.absolute_expires_at > now()
       AND NOT EXISTS (
             SELECT 1 FROM memberships m
               JOIN organizations o ON o.id = m.organization_id
              WHERE m.user_id = u.id AND m.role = 'staff'
                AND o.type = 'internal' AND o.deleted_at IS NULL
           )
     GROUP BY u.email
     ORDER BY u.email
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '[staff] REVOKING   % live staff session(s) held by % — the stamped role no longer matches the rule. They sign in again and get a client session.', r.n, r.email;
  END LOOP;

  UPDATE sessions s
     SET revoked_at = now()
    FROM users u
   WHERE u.id = s.user_id
     AND s.role_at_creation = 'staff'
     AND s.revoked_at IS NULL
     AND s.absolute_expires_at > now()
     AND NOT EXISTS (
           SELECT 1 FROM memberships m
             JOIN organizations o ON o.id = m.organization_id
            WHERE m.user_id = u.id AND m.role = 'staff'
              AND o.type = 'internal' AND o.deleted_at IS NULL
         );
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE NOTICE '[staff] None. No live session is stamped staff for somebody who no longer qualifies. Nothing written.';
  ELSE
    RAISE NOTICE '[staff] REVOKED        % session(s) across % account(s). Only sessions stamped staff, only live ones, only for accounts that fail the new rule — no client session and no qualifying staff session was touched.', v_rows, v_n;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Where that leaves staff, by the new rule.
--
-- A read. The deploy log is the only window onto production, so it carries the
-- answer rather than the steps: who holds a staff session now, and who used to
-- hold one under the company-type rule and no longer does.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r     record;
  v_now int := 0;
  v_was int := 0;
BEGIN
  RAISE NOTICE '[staff] ======== WHO IS STAFF NOW ========';

  FOR r IN
    SELECT u.email, o.slug, u.is_staff
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
      JOIN users u         ON u.id = m.user_id
     WHERE m.role = 'staff' AND o.type = 'internal'
       AND o.deleted_at IS NULL AND u.deleted_at IS NULL
     ORDER BY u.email, o.slug
  LOOP
    v_now := v_now + 1;
    RAISE NOTICE '[staff] STAFF      % @ %  (is_staff=%)', rpad(r.email, 34), rpad(r.slug, 24), r.is_staff;
  END LOOP;

  IF v_now = 0 THEN
    RAISE WARNING '[staff] NOBODY holds a staff session by the new rule. Somebody needs a staff-role membership of the internal company, or there is no way into the staff side of the portal at all.';
  END IF;

  RAISE NOTICE '[staff] ---- held staff under the OLD rule and no longer do ----';
  FOR r IN
    SELECT DISTINCT u.email
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
      JOIN users u         ON u.id = m.user_id
     WHERE o.type = 'internal' AND o.deleted_at IS NULL AND u.deleted_at IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM memberships m2
               JOIN organizations o2 ON o2.id = m2.organization_id
              WHERE m2.user_id = u.id AND m2.role = 'staff'
                AND o2.type = 'internal' AND o2.deleted_at IS NULL
           )
     ORDER BY u.email
  LOOP
    v_was := v_was + 1;
    RAISE NOTICE '[staff] NO LONGER  %  — in the house, but not as staff. They keep their account and everything a member of the house can see; what they lose is every client''s data.', r.email;
  END LOOP;

  IF v_was = 0 THEN
    RAISE NOTICE '[staff] Nobody. Every member of an internal company holds it as staff.';
  END IF;

  RAISE NOTICE '[staff] ==== END ====';
END
$$;
