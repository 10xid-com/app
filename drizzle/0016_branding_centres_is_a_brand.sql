-- BRANDING CENTRES IS A BRAND, NOT THE HOUSE.
--
-- 0013 was written to find out who holds staff in production, because nobody
-- could see. It answered, from the live database:
--
--   branding-centres   internal   1 member   "Branding Centres"
--   tbox-studio        internal   2 members  "TBOX Studio"
--   ...8 client companies...
--   10 companies, of which 2 internal.
--
--   branding-centres   paolo@tboxstudio.com   role=staff   is_staff=true
--   tbox-studio        paolo@tboxstudio.com   role=staff   is_staff=true
--   tbox-studio        peter@tboxstudio.com   role=member  is_staff=true
--
-- Two internal companies is an accident of history, not a decision: the
-- bootstrap block in scripts/migrate.mjs created "Branding Centres" as the
-- internal company on a first deploy, and 0012 later created "TBOX Studio" as
-- the internal company because that is what it is. 0012 found the clash,
-- refused to settle it, and printed why — including the consequence that it
-- could not join Andrew to `branding-centres`, because joining an INTERNAL
-- company is what makes somebody staff over every client, and Andrew is a
-- client-side account.
--
-- Paolo has now decided. TBOX Studio is the house. Branding Centres is one of
-- its client brands, and Andrew runs it. This file writes that down.
--
-- WHAT IT CHANGES, and nothing else:
--
--   1. `branding-centres` is retyped internal -> client.
--   2. Paolo's membership of it stops being `staff` and becomes `owner`.
--   3. andrew@brandingcentres.com is joined to it as a `member` — the join
--      0012 correctly refused to make while the company was internal.
--   4. The `user.act_as.staff` permission row 0014 granted him INSIDE
--      branding-centres is revoked, because it was granted "in the house" and
--      that company is no longer the house.
--
-- WHY `owner` FOR PAOLO, and what the alternatives would have said.
--
--   `staff` is a value of the membership_role enum and it means something
--   specific: a member of the house, working on this client's behalf. On a
--   CLIENT company it is not a smaller version of that, it is a category
--   error — and after the companion change to lib/auth/session.ts, a
--   staff-ROLE membership of a CLIENT company confers nothing at all, so
--   leaving it would be a row that reads as authority and carries none. That
--   is worse than a wrong row; it is a row that misleads whoever reads it next.
--
--   `member` would be true and incomplete. He is not one of Andrew's staff;
--   he owns the brand. `member` would also lose him the ability to invite
--   people into it (app/team/actions.ts admits `owner` or a staff session),
--   which is a real loss of access taken by accident rather than on purpose.
--
--   Deleting the membership would say he has nothing to do with the company,
--   which is false, and would take away his only non-staff route into it.
--
--   `owner` is the honest value: he owns the brand. It is also the value the
--   bootstrap uses for the person answerable for a client company.
--
--   `organizations.owner_user_id` is deliberately NOT set. No code path reads
--   that column today, and writing a value into a column nothing consults is
--   inventing a meaning for it rather than recording a decision.
--
-- WHAT IT DOES NOT DO. It does not touch users.is_staff — that flag and the
-- session derivation are the companion change's subject, and settling half of
-- it here would leave the two halves able to disagree between two deploys. It
-- does not merge `rotary` and `rotary-store`, rename anything, or delete
-- anything. It never touches a row belonging to any other company.
--
-- IDEMPOTENT THROUGHOUT, in the style of 0012 and 0014: every write is guarded
-- by a look first, and a second run writes nothing and says so line by line.
-- Drizzle records what it has applied in __drizzle_migrations and would not
-- normally run this twice, but "normally" is not a guarantee worth resting on
-- in a pre-deploy step, and this database has lost that bookkeeping once
-- already.
--
-- THE LOG IS THE ONLY READ PATH. There is no way into the production database
-- from a developer's machine; the deploy log is the only window onto what this
-- found. Notices reach it because scripts/migrate.mjs attaches a `notice`
-- listener to its pool — node-postgres drops NOTICE on the floor otherwise. If
-- that listener is ever removed, this migration goes silent.

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Retype the company — but only if somebody is still the house afterwards.
--
-- THE GUARD IS THE POINT OF THIS BLOCK. Retyping the only internal company
-- anybody holds a staff-role membership of would, once lib/auth/session.ts
-- reads the membership role, leave NOBODY able to hold a staff session — and
-- there is no sign-up form and no back door to fix it from. So the question is
-- asked first, against the database rather than against what anybody believes
-- is in it: after this change, would at least one live account still hold a
-- `staff`-role membership of a live INTERNAL company?
--
-- If the answer is no, this writes nothing and says why, loudly. Leaving
-- branding-centres internal is safe — it is the state production is in today.
-- Locking the house out of its own portal is not, and it is not a thing to
-- discover from a deploy log after the fact.
--
-- It skips rather than raising. A RAISE EXCEPTION here fails the pre-deploy
-- step and takes the whole deploy down with it, which turns "this one decision
-- could not be applied" into "nothing ships". The refusal is louder in the log
-- than an abort would be, and the next deploy re-asks the question.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org_id     uuid;
  v_org_type   text;
  v_keeps      int;
  v_who        text;
BEGIN
  RAISE NOTICE '[brand] ======== branding-centres: internal -> client ========';

  SELECT o.id, o.type::text INTO v_org_id, v_org_type
    FROM organizations o
   WHERE o.slug = 'branding-centres';

  IF v_org_id IS NULL THEN
    RAISE NOTICE '[brand] SKIPPED — no company on the slug branding-centres. Nothing written.';
    RETURN;
  END IF;

  IF v_org_type = 'client' THEN
    RAISE NOTICE '[brand] already present  branding-centres is already type client. Nothing written.';
    RETURN;
  END IF;

  -- Who would still be the house. Deliberately counts the rule the companion
  -- change introduces — membership role `staff`, in a company that is type
  -- internal — and deliberately excludes branding-centres itself, because the
  -- whole question is what is left once it is no longer internal.
  SELECT count(*), string_agg(u.email || ' @ ' || o.slug, ', ' ORDER BY u.email)
    INTO v_keeps, v_who
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    JOIN users u         ON u.id = m.user_id
   WHERE m.role = 'staff'
     AND o.type = 'internal'
     AND o.id <> v_org_id
     AND o.deleted_at IS NULL
     AND u.deleted_at IS NULL;

  IF v_keeps = 0 THEN
    RAISE WARNING '[brand] REFUSED — branding-centres is the only internal company anybody holds a staff-ROLE membership of. Retyping it to client would leave NOBODY able to hold a staff session once lib/auth/session.ts reads the membership role, and there is no sign-up form to recover through. Nothing written: not the type, not Paolo''s role, not Andrew''s membership. Give somebody a staff-role membership of the internal company that is meant to be the house, then deploy this again.';
    RETURN;
  END IF;

  RAISE NOTICE '[brand] the house afterwards: % staff-role membership(s) of an internal company remain — %', v_keeps, v_who;

  UPDATE organizations SET type = 'client', updated_at = now() WHERE id = v_org_id;
  RAISE NOTICE '[brand] RETYPED        branding-centres internal -> client (organizations.id=%)', v_org_id;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Paolo's membership of it: staff -> owner.
--
-- Guarded on the company being type CLIENT, which is what block 1 leaves
-- behind. That is not belt and braces, it is the interlock: if block 1 refused,
-- the company is still internal, and pulling his role off `staff` there while
-- it is still the house would take his staff access away — the exact outcome
-- block 1 refused in order to avoid.
--
-- One named address, one named company. It does not look for "everybody with a
-- staff role on a client company", because that is a different question with a
-- different blast radius and production may hold rows nobody here has seen.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org_id    uuid;
  v_org_type  text;
  v_user_id   uuid;
  v_role      text;
  v_email     constant text := 'paolo@tboxstudio.com';
BEGIN
  RAISE NOTICE '[brand] ======== % on branding-centres ========', v_email;

  SELECT o.id, o.type::text INTO v_org_id, v_org_type
    FROM organizations o WHERE o.slug = 'branding-centres';

  IF v_org_id IS NULL THEN
    RAISE NOTICE '[brand] SKIPPED — no company on the slug branding-centres.';
    RETURN;
  END IF;

  IF v_org_type <> 'client' THEN
    RAISE NOTICE '[brand] SKIPPED — branding-centres is still type %, so it is still the house and a staff role on it is still meaningful. See the block above for why it was not retyped.', v_org_type;
    RETURN;
  END IF;

  -- The address identifies the account through users.email, the denormalised
  -- copy of the PRIMARY address. A membership is only changed for an account
  -- that already holds one here, so nothing is created and nobody is joined.
  SELECT u.id INTO v_user_id FROM users u WHERE u.email = v_email;

  IF v_user_id IS NULL THEN
    RAISE NOTICE '[brand] SKIPPED — no account on %. Nothing written.', v_email;
    RETURN;
  END IF;

  SELECT m.role::text INTO v_role
    FROM memberships m
   WHERE m.user_id = v_user_id AND m.organization_id = v_org_id;

  IF v_role IS NULL THEN
    RAISE NOTICE '[brand] SKIPPED — % holds no membership of branding-centres. Nothing written, and nothing created: this block changes a role, it does not hand one out.', v_email;

  ELSIF v_role = 'owner' THEN
    RAISE NOTICE '[brand] already present  % is already owner of branding-centres. Nothing written.', v_email;

  ELSIF v_role = 'staff' THEN
    UPDATE memberships SET role = 'owner', updated_at = now()
     WHERE user_id = v_user_id AND organization_id = v_org_id;
    RAISE NOTICE '[brand] CHANGED        % on branding-centres: staff -> owner. WHY owner: he owns the brand. `staff` on a client company is a category error and, once the session role reads the membership role, confers nothing while still reading as authority; `member` would be true, incomplete, and would quietly cost him the right to invite people into his own brand.', v_email;

  ELSE
    RAISE NOTICE '[brand] SKIPPED — % holds branding-centres as %, not staff. Somebody has already decided something here and it is not this migration''s to overwrite. Left exactly as it is.', v_email, v_role;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Andrew, at last.
--
-- 0012 created his account and refused the membership, and printed the reason:
-- `branding-centres` was internal, and joining an internal company is what
-- makes somebody staff over every client's data. That refusal was right. The
-- company is now a client company, so the join it was waiting for can be made.
--
-- `member`, not `owner`. He runs the brand day to day; Paolo owns it. The two
-- differ in exactly one place today — an owner may invite people into the
-- company (app/team/actions.ts) — and handing that out was not what was asked
-- for.
--
-- THE ADDRESS LOOKUP IS 0012's, and for 0012's reason. `users.email` is the
-- denormalised copy of the PRIMARY address, so a hit there means the address IS
-- that account. `user_emails.email` is the real claim and is unique across
-- every account, secondary addresses included — so a hit there with is_primary
-- false means somebody ELSE lists this address as a spare, and that account is
-- not Andrew. 0012's collision rehearsal caught exactly that case writing a
-- membership against the wrong person. A found account is only his when the
-- address is that account's primary.
--
-- Nothing here INSERTS into users. If the account is missing this block says so
-- and stops: creating one would be re-doing 0012's work in a file that is about
-- a membership, and an address already claimed elsewhere would abort the deploy
-- on 0010's trigger, which has no ON CONFLICT on purpose.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org_id        uuid;
  v_org_type      text;
  v_by_users      uuid;
  v_by_emails     uuid;
  v_claim_primary boolean;
  v_user_id       uuid;
  v_role          text;
  v_email         constant text := 'andrew@brandingcentres.com';
BEGIN
  RAISE NOTICE '[brand] ======== % -> branding-centres ========', v_email;

  SELECT o.id, o.type::text INTO v_org_id, v_org_type
    FROM organizations o WHERE o.slug = 'branding-centres';

  IF v_org_id IS NULL THEN
    RAISE NOTICE '[brand] SKIPPED — no company on the slug branding-centres.';
    RETURN;
  END IF;

  IF v_org_type <> 'client' THEN
    RAISE NOTICE '[brand] SKIPPED — branding-centres is type %, not client. This is 0012''s refusal, unchanged and for its original reason: joining an internal company would make a client-side account staff over every client. Nothing written.', v_org_type;
    RETURN;
  END IF;

  SELECT u.id INTO v_by_users FROM users u WHERE u.email = v_email;
  SELECT e.user_id, e.is_primary INTO v_by_emails, v_claim_primary
    FROM user_emails e WHERE e.email = v_email;

  IF v_by_users IS NOT NULL AND v_by_emails IS NOT DISTINCT FROM v_by_users THEN
    v_user_id := v_by_users;
  ELSIF v_by_users IS NOT NULL AND v_by_emails IS NULL THEN
    -- A users row with no user_emails claim. 0009 backfilled and 0010's trigger
    -- guarantees one for everything since, so this should be unreachable —
    -- named rather than assumed away, because such an account cannot sign in.
    v_user_id := v_by_users;
    RAISE NOTICE '[brand] NOTE — the account on % has NO user_emails row, so it cannot sign in until one exists. The membership below is still correct.', v_email;
  ELSIF v_by_users IS NULL AND v_by_emails IS NOT NULL AND v_claim_primary THEN
    v_user_id := v_by_emails;
    RAISE NOTICE '[brand] NOTE — account % holds % as its primary address while its users.email mirror says something else. The address still identifies that account.', v_by_emails, v_email;
  ELSIF v_by_users IS NULL AND v_by_emails IS NULL THEN
    RAISE NOTICE '[brand] SKIPPED — no account on %. 0012 creates it; if that has not run, or was skipped there, this has nothing to join. Nothing written, and no account created here.', v_email;
    RETURN;
  ELSE
    RAISE WARNING '[brand] SKIPPED — the address % does not unambiguously identify one account: users.email says %, user_emails says % (primary: %). Joining the wrong account to a company is not a mistake to make quietly. Nothing written.',
      v_email, v_by_users, v_by_emails, COALESCE(v_claim_primary::text, 'no claim');
    RETURN;
  END IF;

  SELECT m.role::text INTO v_role
    FROM memberships m
   WHERE m.user_id = v_user_id AND m.organization_id = v_org_id;

  IF v_role IS NULL THEN
    INSERT INTO memberships (user_id, organization_id, role)
    VALUES (v_user_id, v_org_id, 'member');
    RAISE NOTICE '[brand] JOINED         % -> branding-centres as member (users.id=%). This is the join 0012 refused to make while the company was internal.', v_email, v_user_id;
  ELSE
    RAISE NOTICE '[brand] already present  % is already % of branding-centres. Left exactly as it is.', v_email, v_role;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The capability 0014 granted inside branding-centres.
--
-- 0014 granted `user.act_as.staff` to Paolo in EVERY internal company he
-- belonged to, rather than in one named slug, precisely because which company
-- was the house was the thing nobody could see from here. With two internal
-- companies it wrote two rows. One of them is in a company that is no longer
-- the house.
--
-- That row is inert today: mayActAsStaff() in lib/auth/act-as.ts asks the
-- question only of INTERNAL organizations he belongs to, so a capability held
-- in a client company answers nothing. Inert is not the same as harmless. It
-- is a live permission row that reads "Paolo may act as staff accounts, within
-- Branding Centres", which is not a sentence anybody means any more, and it
-- would come back to life on its own if that company were ever retyped again.
--
-- Revoked rather than deleted, which is what `revoked_at` is for and what
-- revoke() in lib/db/access.ts does: the row stays as the record that it was
-- granted and withdrawn, and permissions_live_grant_idx stops applying to it.
-- His grant in tbox-studio is untouched — checked below and named, so the log
-- says he did not lose the capability, rather than leaving that to be assumed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org_id   uuid;
  v_org_type text;
  v_user_id  uuid;
  v_revoked  int := 0;
  v_live     int := 0;
  v_where    text;
  v_email    constant text := 'paolo@tboxstudio.com';
  v_cap      constant text := 'user.act_as.staff';
BEGIN
  RAISE NOTICE '[brand] ======== % inside branding-centres ========', v_cap;

  SELECT o.id, o.type::text INTO v_org_id, v_org_type
    FROM organizations o WHERE o.slug = 'branding-centres';
  SELECT u.id INTO v_user_id FROM users u WHERE u.email = v_email;

  IF v_org_id IS NULL OR v_user_id IS NULL THEN
    RAISE NOTICE '[brand] SKIPPED — no such company or no such account. Nothing written.';
    RETURN;
  END IF;

  IF v_org_type <> 'client' THEN
    RAISE NOTICE '[brand] SKIPPED — branding-centres is still type %, so the grant is still held in the house and still means what it said. Nothing written.', v_org_type;
    RETURN;
  END IF;

  UPDATE permissions
     SET revoked_at = now()
   WHERE organization_id = v_org_id
     AND user_id         = v_user_id
     AND capability       = v_cap
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  IF v_revoked = 0 THEN
    RAISE NOTICE '[brand] already present  no live % held by % inside branding-centres. Nothing written.', v_cap, v_email;
  ELSE
    RAISE NOTICE '[brand] REVOKED        % row(s) of % held by % inside branding-centres — granted by 0014 when that company was the house.', v_revoked, v_cap, v_email;
  END IF;

  -- What he still holds, named. A revocation reported without this reads as a
  -- loss of access, and it is not one.
  SELECT count(*), string_agg(o.slug, ', ' ORDER BY o.slug)
    INTO v_live, v_where
    FROM permissions p
    JOIN organizations o ON o.id = p.organization_id
   WHERE p.user_id    = v_user_id
     AND p.capability = v_cap
     AND p.revoked_at IS NULL
     AND o.type = 'internal'
     AND o.deleted_at IS NULL;

  IF v_live = 0 THEN
    RAISE WARNING '[brand] % now holds % in NO internal company. Acting as a STAFF account will be refused for him; acting as a client is unaffected. If that is not intended, grant it in the house — see 0014.', v_email, v_cap;
  ELSE
    RAISE NOTICE '[brand] % still holds % in % internal company(ies): %. Nothing was lost.', v_email, v_cap, v_live, v_where;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Where that leaves the house.
--
-- A read, in the shape of 0013's report, so the deploy log carries the state
-- this migration left behind rather than only the steps it took. Writes
-- nothing.
--
-- The two-internal-companies ambiguity 0013 flagged is resolved here as a side
-- effect: internalOrganization() in lib/db/identity.ts took the first row
-- Postgres happened to return, which with two candidates meant row order
-- decided which company was the house. The companion change makes that function
-- refuse rather than pick; this is what leaves it with one row to find.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r          record;
  v_internal int := 0;
BEGIN
  RAISE NOTICE '[brand] ======== WHERE THAT LEAVES US ========';

  FOR r IN
    SELECT o.slug, o.name,
           (SELECT count(*) FROM memberships m WHERE m.organization_id = o.id) AS members
      FROM organizations o
     WHERE o.type = 'internal' AND o.deleted_at IS NULL
     ORDER BY o.slug
  LOOP
    v_internal := v_internal + 1;
    RAISE NOTICE '[brand] internal company: % ("%") — % member(s)', rpad(r.slug, 24), r.name, r.members;
  END LOOP;

  IF v_internal = 1 THEN
    RAISE NOTICE '[brand] one internal company. internalOrganization() has exactly one row to find, which is what it was always written against.';
  ELSE
    RAISE WARNING '[brand] % internal companies. internalOrganization() takes the first row Postgres returns, so with anything but one, row order decides which company is the house. The companion change makes it refuse instead of guess.', v_internal;
  END IF;

  RAISE NOTICE '[brand] ---- who holds a staff-ROLE membership of an internal company ----';
  FOR r IN
    SELECT u.email, o.slug
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
      JOIN users u         ON u.id = m.user_id
     WHERE m.role = 'staff' AND o.type = 'internal'
       AND o.deleted_at IS NULL AND u.deleted_at IS NULL
     ORDER BY u.email, o.slug
  LOOP
    RAISE NOTICE '[brand] STAFF  % @ %', rpad(r.email, 34), r.slug;
  END LOOP;

  RAISE NOTICE '[brand] ---- branding-centres now ----';
  FOR r IN
    SELECT o.type::text AS type, u.email, m.role::text AS role
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
      JOIN users u         ON u.id = m.user_id
     WHERE o.slug = 'branding-centres'
     ORDER BY u.email
  LOOP
    RAISE NOTICE '[brand] branding-centres (%)  % %', r.type, rpad(r.email, 34), r.role;
  END LOOP;

  RAISE NOTICE '[brand] ==== END — users.is_staff was NOT touched here; that is the companion change''s subject ====';
END
$$;
