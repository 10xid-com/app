-- WHO IS STAFF, AND HOW. A migration that writes nothing.
--
-- There is no read path into the production database from here. The ports are
-- closed, `scripts/seed.ts` truncates and so must never be pointed at it, and
-- the only thing that runs against it is `node scripts/migrate.mjs` as
-- Railway's pre-deploy command. 0012 established that a migration can
-- therefore be used as a REPORT: it attached a `notice` listener to the
-- migrator's pool, so RAISE NOTICE from a .sql file reaches the deploy log.
-- Without that listener node-postgres drops notices on the floor and this file
-- runs silently. It is the whole mechanism; if it is ever removed, this
-- migration stops being able to say anything.
--
-- THIS ONE ONLY LOOKS. Not one statement below is an INSERT, an UPDATE, a
-- DELETE, a CREATE or an ALTER. Every block is a read wrapped in RAISE NOTICE.
-- That is also what makes it safely re-runnable: running it a second time
-- produces a second report of the same rows and changes nothing, so it is
-- harmless if drizzle's __drizzle_migrations bookkeeping is ever lost or a
-- database is rebuilt from the folder.
--
-- WHY IT WAS ASKED FOR. lib/auth/session.ts derives a session's role from the
-- TYPE of a company somebody belongs to, not from the role on the membership:
--
--   const role = mships.some((m) => m.organizationType === "internal")
--     ? "staff" : "client";
--
-- So membership of the internal company IS staff over every client, whatever
-- the membership says — a `member` of the internal company outranks an `owner`
-- of a client. Paolo has decided Branding Centres is a client brand and TBOX
-- Studio is the house. Retyping `branding-centres` from internal to client
-- would remove staff from whoever is in it, and from here there is no way to
-- see who that is. This answers that question and does nothing about it. It
-- does not change the derivation and it does not retype a single row; the
-- decision stays with a human who can see this output.
--
-- WHAT IT PRINTS, AND WHOSE ADDRESSES APPEAR.
--
--   1. Every company: slug, type, and how many members it has. No addresses.
--   2. Every membership of an INTERNAL company: the person's address, their
--      membership_role, and their users.is_staff. Addresses appear here and
--      are proportionate: these are the few rows that carry power over every
--      client, and naming them is the point of the exercise.
--   3. Totals — users, memberships, organizations.
--   4. Anybody whose users.is_staff is true but who holds NO membership with
--      role = 'staff'. Those are the people who would lose staff access if the
--      rule were changed to read the membership role instead of the company
--      type.
--
-- Addresses are NOT printed for memberships of client companies. Production
-- holds ~71 real accounts and putting ~70 people's addresses into a deploy log
-- serves nothing here. Block 4 has a ceiling on it for the same reason: it
-- names people only while the flagged set is small enough to be the handful it
-- is expected to be, and falls back to ids if it is not.
--
-- Deleted rows are INCLUDED and marked. organizations and users both carry a
-- deleted_at, and membershipsForUser() filters deleted organizations out while
-- nothing filters deleted users — so a report that quietly dropped them would
-- disagree with the application about who is in what.

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Every company, and how many people are in it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r         record;
  v_total   int := 0;
  v_internal int := 0;
BEGIN
  RAISE NOTICE '[audit] ================ COMPANIES ================';

  FOR r IN
    SELECT o.slug,
           o.type::text AS type,
           o.name,
           o.deleted_at,
           (SELECT count(*) FROM memberships m WHERE m.organization_id = o.id) AS members
      FROM organizations o
     ORDER BY o.type::text DESC, o.slug
  LOOP
    v_total := v_total + 1;
    IF r.type = 'internal' THEN
      v_internal := v_internal + 1;
    END IF;

    RAISE NOTICE '[audit] % % % member(s)%   "%"',
      rpad(r.slug, 24),
      rpad(r.type, 8),
      lpad(r.members::text, 3),
      CASE WHEN r.deleted_at IS NOT NULL THEN '  [DELETED ' || r.deleted_at::date || ']' ELSE '' END,
      r.name;
  END LOOP;

  RAISE NOTICE '[audit] % companies, of which % internal.', v_total, v_internal;

  IF v_internal <> 1 THEN
    RAISE NOTICE '[audit] NOTE: the code assumes ONE internal company — internalOrganization() in lib/db/identity.ts takes the first it finds, and the session role is true if ANY membership is of an internal company. % of them is not what that was written against.', v_internal;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Every membership of an internal company — the security-critical ones.
--
-- Addresses appear here on purpose. These rows are what the session role is
-- computed from, so "who is in the internal company" and "who is staff over
-- every client" are the same list, and a list of that with the names removed
-- would not answer anything.
--
-- users.is_staff is printed beside the membership because it is a stored COPY
-- of the same fact, written at invitation time (lib/db/invitations.ts:
-- `isStaff = org?.type === "internal"`). A copy can drift from the thing it
-- copies, and where it has, that is worth seeing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r       record;
  v_n     int := 0;
  v_drift int := 0;
BEGIN
  RAISE NOTICE '[audit] ======== MEMBERS OF INTERNAL COMPANIES ========';

  FOR r IN
    SELECT o.slug            AS org_slug,
           o.deleted_at      AS org_deleted_at,
           u.email,
           u.id              AS user_id,
           m.role::text      AS membership_role,
           u.is_staff,
           u.is_service,
           u.deleted_at      AS user_deleted_at
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
      JOIN users u         ON u.id = m.user_id
     WHERE o.type = 'internal'
     ORDER BY o.slug, u.email
  LOOP
    v_n := v_n + 1;
    IF NOT r.is_staff THEN
      v_drift := v_drift + 1;
    END IF;

    -- The flags are concatenated into ONE argument rather than left as four
    -- adjacent placeholders: in RAISE, `%%` is an escaped literal percent, so
    -- `%%%%` reads as two literal percent signs and not as four substitutions.
    -- The flag and the tail are ONE argument, not two adjacent placeholders:
    -- in RAISE, `%%` is an escaped literal percent, so two substitutions
    -- written side by side silently become a printed percent sign and an
    -- argument-count error. Anything that would abut another placeholder is
    -- concatenated into a single expression instead.
    RAISE NOTICE '[audit] % % role=% is_staff=%',
      rpad(r.org_slug, 24),
      rpad(r.email, 34),
      rpad(r.membership_role, 6),
      (CASE WHEN r.is_staff THEN 'true ' ELSE 'FALSE' END)
      || CASE WHEN r.is_service    THEN '  [service account]'  ELSE '' END
      || CASE WHEN r.user_deleted_at IS NOT NULL THEN '  [user DELETED]'    ELSE '' END
      || CASE WHEN r.org_deleted_at  IS NOT NULL THEN '  [company DELETED]' ELSE '' END;
  END LOOP;

  IF v_n = 0 THEN
    RAISE NOTICE '[audit] No memberships of any internal company. Nobody holds a staff session by the current rule.';
  ELSE
    RAISE NOTICE '[audit] % membership(s) of an internal company. Every one of these is a staff session by the current rule, whatever the membership role says.', v_n;
  END IF;

  IF v_drift > 0 THEN
    RAISE NOTICE '[audit] % of them have users.is_staff FALSE while belonging to an internal company. The stored flag disagrees with the derivation; the derivation is what the session actually uses. Nothing changed here.', v_drift;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Totals.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_users        int;
  v_users_live   int;
  v_memberships  int;
  v_orgs         int;
  v_orgs_live    int;
  v_emails       int;
BEGIN
  SELECT count(*) INTO v_users       FROM users;
  SELECT count(*) INTO v_users_live  FROM users WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_memberships FROM memberships;
  SELECT count(*) INTO v_orgs        FROM organizations;
  SELECT count(*) INTO v_orgs_live   FROM organizations WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_emails      FROM user_emails;

  RAISE NOTICE '[audit] ================ TOTALS ================';
  RAISE NOTICE '[audit] users         % (% not deleted)', v_users, v_users_live;
  RAISE NOTICE '[audit] memberships   %', v_memberships;
  RAISE NOTICE '[audit] organizations % (% not deleted)', v_orgs, v_orgs_live;
  RAISE NOTICE '[audit] user_emails   % — for comparison with users; 0009 backfilled one per account and 0010''s trigger writes one per INSERT, so a shortfall means accounts that cannot sign in.', v_emails;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Who would lose staff access if the rule read the membership role.
--
-- The flag asked for: users.is_staff is true, and the account holds NO
-- membership anywhere with role = 'staff'. Today their staff-ness comes from
-- the TYPE of a company they belong to (or from a flag nobody has revisited);
-- under a rule that read the membership role instead, they would have nothing.
--
-- The ceiling: these are expected to be a handful, and while they are, they
-- are named — an account carrying is_staff is in the same category as block 2
-- and a list of ids would not be actionable. Past the ceiling the set is not
-- the handful it was supposed to be, which is itself the finding, and it
-- degrades to ids so that a surprise cannot dump a large number of addresses
-- into a deploy log.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r        record;
  v_n      int;
  v_named  boolean;
  v_mirror int;
  c_ceiling constant int := 25;
BEGIN
  RAISE NOTICE '[audit] ==== is_staff WITHOUT A staff-ROLE MEMBERSHIP ====';

  SELECT count(*) INTO v_n
    FROM users u
   WHERE u.is_staff
     AND NOT EXISTS (
           SELECT 1 FROM memberships m
            WHERE m.user_id = u.id AND m.role = 'staff'
         );

  v_named := v_n <= c_ceiling;

  IF v_n = 0 THEN
    RAISE NOTICE '[audit] None. Every account with is_staff also holds a membership with role = ''staff''.';
  ELSE
    IF NOT v_named THEN
      RAISE NOTICE '[audit] % accounts — more than the ceiling of %, so ids only. That count is itself the finding.', v_n, c_ceiling;
    END IF;

    FOR r IN
      SELECT u.id,
             u.email,
             u.deleted_at,
             u.is_service,
             (SELECT string_agg(o.slug || ':' || m.role::text || ':' || o.type::text, ', ' ORDER BY o.slug)
                FROM memberships m
                JOIN organizations o ON o.id = m.organization_id
               WHERE m.user_id = u.id) AS held
        FROM users u
       WHERE u.is_staff
         AND NOT EXISTS (
               SELECT 1 FROM memberships m
                WHERE m.user_id = u.id AND m.role = 'staff'
             )
       ORDER BY u.email
    LOOP
      RAISE NOTICE '[audit] WOULD LOSE STAFF  %  holds: %',
        CASE WHEN v_named THEN rpad(r.email, 34) ELSE r.id::text END,
        COALESCE(r.held, '(no memberships at all)')
        || CASE WHEN r.is_service THEN '  [service account]' ELSE '' END
        || CASE WHEN r.deleted_at IS NOT NULL THEN '  [DELETED]' ELSE '' END;
    END LOOP;

    RAISE NOTICE '[audit] % account(s) would lose staff access if the derivation read membership_role instead of company type. Reported only — nothing was changed, and lib/auth/session.ts is untouched.', v_n;
  END IF;

  -- The mirror image, as a count and nothing more. Someone holding a
  -- staff-role membership while users.is_staff is false is the same
  -- disagreement seen from the other side, and it costs one query to say so.
  SELECT count(*) INTO v_mirror
    FROM users u
   WHERE NOT u.is_staff
     AND EXISTS (
           SELECT 1 FROM memberships m
            WHERE m.user_id = u.id AND m.role = 'staff'
         );
  RAISE NOTICE '[audit] For comparison: % account(s) hold a staff-ROLE membership while users.is_staff is false. Count only, no addresses — they are not what was asked for.', v_mirror;

  RAISE NOTICE '[audit] ==== END OF REPORT — nothing above wrote anything ====';
END
$$;
