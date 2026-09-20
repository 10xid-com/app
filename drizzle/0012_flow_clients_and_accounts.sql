-- The eight companies and the eight people who are going to test Flow.
--
-- This is DATA, not schema, and it is here rather than in scripts/seed.ts
-- because seed.ts truncates. Truncating is right for a development database
-- and catastrophic for this one, so the seed must never be pointed at
-- production. The only thing that runs against production is
-- `node scripts/migrate.mjs` as Railway's pre-deploy command, so a row that
-- has to exist in production is written by a migration or not at all. Do not
-- regenerate this file with drizzle-kit; it describes rows, not tables, and
-- drizzle-kit would not produce it and will not preserve it.
--
-- NOTHING HERE SENDS EMAIL. Mail leaves this system from exactly two places:
-- sendSignInCode(), when somebody asks for a code, and sendInvitation(), when
-- somebody is invited. Writing a `users` row touches neither. That is the
-- whole reason these accounts are created as rows instead of through the
-- invitation path — an invitation would put eight messages in front of eight
-- people who have not been told to expect them.
--
-- WHAT IT DOES ON A SECOND RUN: nothing, and says so line by line. Drizzle's
-- migrator will not normally run a migration twice — it records what it has
-- applied in __drizzle_migrations — but "normally" is not a guarantee worth
-- resting on when the failure lands in a pre-deploy step. So every write is
-- guarded by a look first: a company is inserted only when its slug is absent,
-- a person only when their address is claimed by nobody, a membership only
-- when that pair is not already joined. Run it ten times and the tenth is a
-- read-only report.
--
-- IT NEVER UPDATES AND NEVER DELETES. Not one statement below is an UPDATE or
-- a DELETE. If a row is already there it is left exactly as it is, whatever it
-- says, and the log records what was found. Production has ~71 real accounts
-- and their history is worth more than this file's idea of tidiness.
--
-- THE COLLISION IT WAS WRITTEN FOR. The bootstrap block in scripts/migrate.mjs
-- creates an INTERNAL company called "Branding Centres" on the slug
-- `branding-centres`, plus "Rotary" on `rotary`, and a staff account on
-- BOOTSTRAP_EMAIL — which is Paolo's address. Production very likely has all
-- of them. The table below wants `branding-centres` as a CLIENT. That clash is
-- not an error and it is not this migration's to settle: it reports what it
-- found and leaves the row alone. Two consequences are called out in the log
-- where they happen, because they are decisions for a human:
--
--   * a person is NOT joined to a company whose type is not the one intended
--     here. Joining `branding-centres` while it is internal would make that
--     person STAFF — lib/auth/session.ts reads the role off membership of an
--     internal company, not off the membership role — so Andrew would see
--     every client's jobs. Skipped, and the reason printed.
--   * "Rotary Store" is a different slug from the bootstrap's "Rotary", so
--     both will exist afterwards. That is what was asked for; merging them is
--     separate work.
--
-- THE TRAP THAT WOULD KILL THE DEPLOY. 0010 puts an AFTER INSERT trigger on
-- `users` that writes the primary `user_emails` row with NO ON CONFLICT, on
-- purpose, so that an address already claimed by somebody else fails loudly
-- rather than producing an account that can never sign in. That means an
-- INSERT into `users` for a claimed address does not fail politely — it
-- aborts the statement, the migration, and the pre-deploy step, and the deploy
-- with it. So the check below looks in BOTH places: `users.email`, and
-- `user_emails.email`, which can hold the address as somebody else's
-- secondary. An address found in either is skipped and named — and skipped
-- for the MEMBERSHIP too, because an account that merely lists the address as
-- a spare is not the person named here, and joining it to an internal company
-- would hand a stranger staff access. The collision rehearsal caught exactly
-- that; see the comment on the account lookup below.
--
-- Addresses are written already lowercased, matching what the application
-- does everywhere it stores one (`email.trim().toLowerCase()` — see
-- lib/db/identity.ts and app/auth/actions.ts). The lookups compare against
-- the stored lowercase form for the same reason.
--
-- email_verified_at is deliberately left NULL. Nobody has proved they own
-- these mailboxes yet, and writing now() would be recording a verification
-- that never happened. It costs nothing: sign-in resolves through
-- user_emails and exempts the PRIMARY address from the verified test (see
-- findUserByEmail), and lib/auth/codes.ts stamps emailVerifiedAt on the first
-- successful sign-in anyway.
--
-- THE LOG IS THE POINT. There is no read path into the production database
-- from here; the deploy log is the only window onto what this found. Notices
-- reach it because scripts/migrate.mjs now attaches a `notice` listener to its
-- pool — node-postgres drops NOTICE on the floor otherwise, listener or no
-- log. If that listener is ever removed, this migration goes silent and the
-- one thing it was supposed to tell us is lost.

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The companies.
--
-- `organizations.type` is `internal | client`, as it stands today. Nothing
-- here renames it. A terminology change ("client record" vs "organization")
-- is separate work.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r          record;
  v_id       uuid;
  v_type     text;
  v_name     text;
  v_created  int := 0;
  v_present  int := 0;
  v_conflict int := 0;
BEGIN
  RAISE NOTICE '[flow] ============ CLIENT RECORDS ============';

  FOR r IN
    SELECT * FROM (VALUES
      ('TBOX Studio',        'tbox-studio',        'internal'),
      ('Vinyl Wrap Toronto', 'vinyl-wrap-toronto', 'client'),
      ('Branding Centres',   'branding-centres',   'client'),
      ('Rotary Store',       'rotary-store',       'client'),
      ('Workwear Toronto',   'workwear-toronto',   'client'),
      ('416print',           '416print',           'client'),
      ('Print Three',        'print-three',        'client'),
      ('10XiD',              '10xid',              'client')
    ) AS t(name, slug, type)
  LOOP
    -- slug is UNIQUE on organizations, so this is the whole question.
    SELECT o.id, o.type::text, o.name
      INTO v_id, v_type, v_name
      FROM organizations o
     WHERE o.slug = r.slug;

    IF v_id IS NULL THEN
      INSERT INTO organizations (type, name, slug)
      VALUES (r.type::organization_type, r.name, r.slug);
      v_created := v_created + 1;
      RAISE NOTICE '[flow] CREATED         % (%) as %', rpad(r.name, 20), r.slug, r.type;

    ELSIF v_type = r.type THEN
      v_present := v_present + 1;
      RAISE NOTICE '[flow] already present % (%) as % — existing row left untouched, stored name is "%"',
        rpad(r.name, 20), r.slug, v_type, v_name;

    ELSE
      v_conflict := v_conflict + 1;
      RAISE NOTICE '[flow] SKIPPED         % (%) — WHY: the slug is taken by an existing % company named "%", and this migration wanted %. Not renamed, not retyped, not deleted. Somebody has to decide what that row should be.',
        rpad(r.name, 20), r.slug, v_type, v_name, r.type;
    END IF;
  END LOOP;

  RAISE NOTICE '[flow] client records THIS RUN: % created, % already present, % left alone on a type clash',
    v_created, v_present, v_conflict;
  RAISE NOTICE '[flow] client records NOW: % of 8 exist with the slug and type intended here',
    v_created + v_present;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The people, and what they belong to.
--
-- Account and membership are done together per person because they answer
-- each other: is_staff on a new account follows from the TYPE of the company
-- the person is actually joined to, which is the same test that decides
-- whether the membership may be written at all. lib/db/invitations.ts settles
-- it the same way — `isStaff = org?.type === "internal"` — so staff-ness is
-- never something a form or a role name can hand out.
--
-- An existing account is never touched, is_staff included. If somebody who is
-- already in the database gains an internal membership here and their
-- is_staff flag disagrees, that is printed as a WARNING rather than fixed:
-- the flag is a stored copy of a fact, and changing a live account's
-- privileges from a migration is not something that should happen quietly.
--
-- The roles below are values of the `membership_role` enum as it stands —
-- owner | member | staff — and nothing here invents a new one. Paolo is
-- `staff`; everybody else is `member`.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  p               record;
  v_org_id        uuid;
  v_org_type      text;
  v_org_ok        boolean;
  v_is_staff      boolean;
  v_by_users      uuid;
  v_by_emails     uuid;
  v_claim_primary boolean;
  v_user_id       uuid;
  v_new_user      boolean;
  v_user_staff    boolean;
  v_role          text;
  v_u_created     int := 0;
  v_u_present     int := 0;
  v_u_skipped     int := 0;
  v_m_created     int := 0;
  v_m_present     int := 0;
  v_m_skipped     int := 0;
BEGIN
  RAISE NOTICE '[flow] ============ PEOPLE ============';

  FOR p IN
    SELECT * FROM (VALUES
      ('Paolo',  'paolo@tboxstudio.com',       'tbox-studio',        'internal', 'staff'),
      ('Peter',  'peter@tboxstudio.com',       'tbox-studio',        'internal', 'member'),
      ('Joel',   'joel@vinylwraptoronto.com',  'vinyl-wrap-toronto', 'client',   'member'),
      ('Imran',  'imran@vinylwraptoronto.com', 'vinyl-wrap-toronto', 'client',   'member'),
      ('Rana',   'rana@vinylwraptoronto.com',  'vinyl-wrap-toronto', 'client',   'member'),
      ('Andrew', 'andrew@brandingcentres.com', 'branding-centres',   'client',   'member'),
      ('Reza',   'reza@print3.net',            'print-three',        'client',   'member'),
      ('Ethan',  'ethan@10xid.com',            '10xid',              'client',   'member')
    ) AS t(full_name, email, slug, org_type, role)
  LOOP
    ---------------------------------------------------------------------
    -- Which company, and may this person be joined to it?
    ---------------------------------------------------------------------
    SELECT o.id, o.type::text INTO v_org_id, v_org_type
      FROM organizations o
     WHERE o.slug = p.slug;

    -- The type has to match what was intended, not merely exist. A company
    -- sitting on the expected slug as the WRONG type is the branding-centres
    -- case, and joining it would hand out staff access by accident.
    v_org_ok   := v_org_id IS NOT NULL AND v_org_type = p.org_type;
    v_is_staff := v_org_ok AND p.org_type = 'internal';

    ---------------------------------------------------------------------
    -- The account.
    --
    -- Both tables are consulted, and they answer different questions.
    -- `users.email` is the denormalised copy of the PRIMARY address, so a hit
    -- there means this address IS that account. `user_emails.email` is the
    -- real claim and is unique across every account, secondary addresses
    -- included — so a hit there with is_primary false means somebody ELSE has
    -- listed this address as a spare.
    --
    -- The difference decides two things, not one. It decides whether to
    -- insert (a claimed address must never be inserted: 0010's trigger has no
    -- ON CONFLICT and would abort the deploy) and it decides WHOSE account
    -- this is. An earlier version of this file collapsed the two with a
    -- COALESCE, and the collision rehearsal caught what that does: the
    -- address was somebody else's secondary, so the account found was
    -- somebody else's, and the membership was written against THEM — joining
    -- an unrelated person to TBOX Studio, which is an internal company, which
    -- would have made them staff. A found account is only this person's
    -- account when the address is that account's primary.
    ---------------------------------------------------------------------
    SELECT u.id INTO v_by_users FROM users u WHERE u.email = p.email;
    SELECT e.user_id, e.is_primary INTO v_by_emails, v_claim_primary
      FROM user_emails e WHERE e.email = p.email;

    v_user_id  := NULL;
    v_new_user := false;

    IF v_by_users IS NULL AND v_by_emails IS NULL THEN
      INSERT INTO users (email, full_name, is_staff, is_service)
      VALUES (p.email, p.full_name, v_is_staff, false)
      RETURNING id INTO v_user_id;
      -- users_primary_email_ins wrote the user_emails row for us.
      v_new_user  := true;
      v_u_created := v_u_created + 1;
      RAISE NOTICE '[flow] CREATED         % <%> — staff: %', rpad(p.full_name, 8), p.email,
        CASE WHEN v_is_staff THEN 'yes' ELSE 'no' END;

    ELSIF v_by_users IS NOT NULL AND v_by_emails IS NOT DISTINCT FROM v_by_users THEN
      v_user_id   := v_by_users;
      v_u_present := v_u_present + 1;
      RAISE NOTICE '[flow] already present % <%> — WHY SKIPPED: that address is already this account (users.id=%). Left exactly as it is.',
        rpad(p.full_name, 8), p.email, v_user_id;

    ELSIF v_by_users IS NOT NULL AND v_by_emails IS NULL THEN
      -- A users row with no user_emails claim. 0009 backfilled and 0010's
      -- trigger guarantees it for everything since, so this should not be
      -- reachable — printed rather than assumed away, because an account in
      -- that state cannot sign in at all and somebody should know.
      v_user_id   := v_by_users;
      v_u_present := v_u_present + 1;
      RAISE NOTICE '[flow] already present % <%> — WHY SKIPPED: an account already holds this address (users.id=%). NOTE: it has NO user_emails row, so it cannot sign in until one exists.',
        rpad(p.full_name, 8), p.email, v_user_id;

    ELSIF v_by_users IS NOT NULL THEN
      -- users.email says one account, user_emails says another. Only
      -- setPrimaryEmail() writes users.email and it writes both tables in one
      -- transaction, so this means something has gone wrong that is well
      -- outside this migration's business. Touch nothing, name both rows.
      v_u_skipped := v_u_skipped + 1;
      RAISE NOTICE '[flow] SKIPPED         % <%> — WHY: two accounts disagree over this address — users.email says %, user_emails says %. Nothing written, and no membership either: there is no way to tell from here which account is this person.',
        rpad(p.full_name, 8), p.email, v_by_users, v_by_emails;

    ELSIF v_claim_primary THEN
      -- Held as the PRIMARY address of an account whose users.email mirror is
      -- stale. The address still identifies that account, so it is this
      -- person and the membership below may safely use it.
      v_user_id   := v_by_emails;
      v_u_present := v_u_present + 1;
      RAISE NOTICE '[flow] already present % <%> — WHY SKIPPED: account % holds this as its primary address (its users.email mirror says something else). Left exactly as it is.',
        rpad(p.full_name, 8), p.email, v_user_id;

    ELSE
      -- Somebody else's SECONDARY address. Two separate refusals follow from
      -- it: no INSERT, because the trigger would abort the deploy, and no
      -- membership, because that account is not this person.
      v_u_skipped := v_u_skipped + 1;
      RAISE NOTICE '[flow] SKIPPED         % <%> — WHY: the address is already claimed in user_emails by account % as a SECONDARY address, so it is not this person''s account. Creating one would abort this migration on 0010''s trigger; joining that account to % would put a stranger in it. Nothing written.',
        rpad(p.full_name, 8), p.email, v_by_emails, p.slug;
    END IF;

    ---------------------------------------------------------------------
    -- The membership.
    ---------------------------------------------------------------------
    IF v_user_id IS NULL THEN
      v_m_skipped := v_m_skipped + 1;
      RAISE NOTICE '[flow]   membership    % → % — WHY SKIPPED: no account to join (see above).',
        rpad(p.full_name, 8), p.slug;

    ELSIF v_org_id IS NULL THEN
      v_m_skipped := v_m_skipped + 1;
      RAISE NOTICE '[flow]   membership    % → % — WHY SKIPPED: no company on that slug.',
        rpad(p.full_name, 8), p.slug;

    ELSIF NOT v_org_ok THEN
      v_m_skipped := v_m_skipped + 1;
      RAISE NOTICE '[flow]   membership    % → % — WHY SKIPPED: that company is type %, this migration expected %. Joining an internal company makes a person STAFF (session role comes from membership of an internal company, not from the membership role), so this is not a join to make on a guess.',
        rpad(p.full_name, 8), p.slug, v_org_type, p.org_type;

    ELSE
      SELECT m.role::text INTO v_role
        FROM memberships m
       WHERE m.user_id = v_user_id AND m.organization_id = v_org_id;

      IF v_role IS NULL THEN
        INSERT INTO memberships (user_id, organization_id, role)
        VALUES (v_user_id, v_org_id, p.role::membership_role);
        v_m_created := v_m_created + 1;
        RAISE NOTICE '[flow]   membership    CREATED % → % as %', rpad(p.full_name, 8), p.slug, p.role;

        -- The stored copy of staff-ness on an account we did not create.
        IF NOT v_new_user AND p.org_type = 'internal' THEN
          SELECT u.is_staff INTO v_user_staff FROM users u WHERE u.id = v_user_id;
          IF NOT v_user_staff THEN
            RAISE WARNING '[flow]   % now belongs to an internal company but users.is_staff is false on their existing account. NOT changed here — a migration should not quietly grant staff access. Set it deliberately if that is what is wanted.',
              p.email;
          END IF;
        END IF;

      ELSIF v_role = p.role THEN
        v_m_present := v_m_present + 1;
        RAISE NOTICE '[flow]   membership    already present % → % as % — WHY SKIPPED: that pair is already joined.',
          rpad(p.full_name, 8), p.slug, v_role;

      ELSE
        v_m_present := v_m_present + 1;
        RAISE NOTICE '[flow]   membership    already present % → % as % — WHY SKIPPED: that pair is already joined. This migration would have used %; the existing role wins and is left alone.',
          rpad(p.full_name, 8), p.slug, v_role, p.role;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE '[flow] ============ WHERE THAT LEAVES US ============';
  RAISE NOTICE '[flow] accounts THIS RUN: % created, % already present, % skipped on a claimed address',
    v_u_created, v_u_present, v_u_skipped;
  RAISE NOTICE '[flow] accounts NOW: % of 8 exist', v_u_created + v_u_present;
  RAISE NOTICE '[flow] memberships THIS RUN: % created, % already present, % skipped',
    v_m_created, v_m_present, v_m_skipped;
  RAISE NOTICE '[flow] memberships NOW: % of 8 of the intended pairs are joined',
    v_m_created + v_m_present;
  IF (v_u_created + v_u_present) < 8 OR (v_m_created + v_m_present) < 8 THEN
    RAISE NOTICE '[flow] Anything short of 8 is explained by a SKIPPED line above. Nothing was overwritten or renamed to get these numbers.';
  END IF;
END
$$;
