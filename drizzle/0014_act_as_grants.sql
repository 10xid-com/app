-- ACTING AS SOMEBODY ELSE.
--
-- Paolo needs to see Flow from each person's side. Signing in as them is
-- impossible by design — the code goes to their real inbox — and asking them
-- for it would be asking for their credential. So this: a staff session trades
-- its identity for a time-boxed, reasoned, logged grant to be ONE person.
--
-- It is `staff_grants` in the same shape, deliberately. Staff already trade
-- their identity for a bounded grant to one CLIENT; this is the same trade for
-- one PERSON. Inventing a second kind of elevated access with its own rules is
-- how one of them ends up with weaker ones.
--
-- WHAT MAKES IT A TEST TOOL AND NOT A BACK DOOR, and where each part lives:
--
--   No permanent takeover — lib/auth/require.ts and the routes that call it.
--     While a grant is live you may not change their address, enrol an
--     authenticator, read their recovery codes or end their other sessions.
--     Everything a grant is FOR stops when it lapses; those four would not.
--   No chaining — lib/auth/act-as.ts. Acting as Joel you may renew Joel and
--     may not become anybody else.
--   Time-boxed and visible — expires_at below, sixty minutes, and the banner
--     in app/portal-shell.tsx, which the shell resolves itself rather than
--     taking as a prop a page could forget.
--   Logged — this table, and `reason` is NOT NULL.
--
-- THIS FILE IS SCHEMA PLUS ONE ROW. The row is the capability, at the end, and
-- it is guarded by a look first in the style of 0012: a second run writes
-- nothing and says so.

CREATE TABLE "act_as_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "act_as_grants" ADD CONSTRAINT "act_as_grants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "act_as_grants" ADD CONSTRAINT "act_as_grants_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "act_as_grants" ADD CONSTRAINT "act_as_grants_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "act_as_grants_session_idx" ON "act_as_grants" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "act_as_grants_actor_idx" ON "act_as_grants" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "act_as_grants_target_idx" ON "act_as_grants" USING btree ("target_user_id");--> statement-breakpoint

-- Nobody is ever themselves. The application refuses it too, but a constraint
-- is what survives the next caller.
ALTER TABLE act_as_grants
  ADD CONSTRAINT act_as_grants_not_self CHECK (actor_user_id <> target_user_id);

--> statement-breakpoint

-- A reason that is not a keystroke. Eight characters, the same floor
-- chooseClientAction uses, enforced here as well as in the form because this
-- table IS the audit and a row that cannot say why is a row that answers
-- nothing.
ALTER TABLE act_as_grants
  ADD CONSTRAINT act_as_grants_reason_present CHECK (length(btrim(reason)) >= 8);

--> statement-breakpoint

-- An hour is the policy; the constraint only says time runs forwards.
ALTER TABLE act_as_grants
  ADD CONSTRAINT act_as_grants_window_forwards CHECK (expires_at > started_at);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- BOTH IDENTITIES ON EVERY WRITE.
--
-- `job_events.actor_id` stays whoever the work was done AS. That is the point
-- of the feature and the right answer for a client's own history: their job
-- list should read as their work, not as a stranger rummaging in it.
--
-- What `actor_id` alone cannot say is that a different human was at the
-- keyboard. These three say it. They are NULL on every ordinary row, so NULL
-- is an assertion — "this was real work, by the person named" — and not merely
-- an absence. Six months from now that is the difference between Paolo's test
-- data and a client's real history, and it cannot be reconstructed later.
--
-- The check constraint keeps the three together: a real actor with no address
-- beside them, or a grant id with no actor, would be a half-written record and
-- worse than none.
-- ---------------------------------------------------------------------------
ALTER TABLE "job_events" ADD COLUMN "real_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "real_actor_email_at_time" text;--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "act_as_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_real_actor_id_users_id_fk" FOREIGN KEY ("real_actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_act_as_grant_id_act_as_grants_id_fk" FOREIGN KEY ("act_as_grant_id") REFERENCES "public"."act_as_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE job_events
  ADD CONSTRAINT job_events_real_actor_complete CHECK (
    (real_actor_id IS NULL AND real_actor_email_at_time IS NULL AND act_as_grant_id IS NULL)
    OR
    (real_actor_id IS NOT NULL AND real_actor_email_at_time IS NOT NULL AND act_as_grant_id IS NOT NULL)
  );

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What the application may do with the table.
--
-- SELECT to read the live grant on every request, INSERT to start one, UPDATE
-- to end one. NO DELETE, the same posture `job_events` and `recovery_codes`
-- take: erasing the record of an impersonation is a permission error at the
-- database rather than a decision anybody can quietly make.
--
-- No row-level security, and for the same reason `staff_grants` has none: this
-- is an INPUT to the scope, read before one exists, and it carries no
-- organization_id to filter on. scripts/check-rls.ts finds tables by that
-- column, so it neither demands a policy here nor needs a new exemption.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON act_as_grants TO portal_app;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- "Paolo may act as anyone, staff included, until further notice."
--
-- That sentence is a permission row, not an `if`. Targeting a non-staff
-- account needs only a staff session; targeting a STAFF account additionally
-- needs `user.act_as.staff`. Granting it here means "until further notice"
-- can be withdrawn with one UPDATE — `revoke()` in lib/db/access.ts stamps
-- revoked_at — instead of needing a deploy, which is what a name in the source
-- would have cost.
--
-- Granted in every INTERNAL organization he belongs to, not in one named slug.
-- Production may hold `branding-centres` as the internal company, or
-- `tbox-studio`, or both; 0013 was written to find out and the answer is not
-- known from here. The check in lib/auth/act-as.ts asks the same question the
-- same way — does he hold it in ANY internal organization he is a member of —
-- so the grant and the check cannot disagree about which company is the house.
--
-- granted_by is Paolo himself. There is nobody above him to record and
-- inventing a system account to sign it would be recording a fiction.
--
-- Guarded by a look first, like everything in 0012: if the account is absent,
-- if he is in no internal company, or if the grant is already there, this
-- writes nothing and says which.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r           record;
  v_user_id   uuid;
  v_email     constant text := 'paolo@tboxstudio.com';
  v_cap       constant text := 'user.act_as.staff';
  v_created   int := 0;
  v_present   int := 0;
  v_orgs      int := 0;
BEGIN
  RAISE NOTICE '[act-as] ======== % ========', v_cap;

  SELECT u.id INTO v_user_id
    FROM users u
   WHERE u.email = v_email AND u.deleted_at IS NULL;

  IF v_user_id IS NULL THEN
    RAISE NOTICE '[act-as] SKIPPED — no live account on %. Nothing written. Acting as a STAFF account will be refused for everybody until this capability is granted to somebody; acting as a client is unaffected.', v_email;
    RETURN;
  END IF;

  FOR r IN
    SELECT o.id, o.slug
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = v_user_id
       AND o.type = 'internal'
       AND o.deleted_at IS NULL
     ORDER BY o.slug
  LOOP
    v_orgs := v_orgs + 1;

    -- permissions_live_grant_idx makes the duplicate impossible anyway; the
    -- look first is so the log can say which of the two happened.
    IF EXISTS (
      SELECT 1 FROM permissions p
       WHERE p.organization_id = r.id
         AND p.user_id         = v_user_id
         AND p.capability      = v_cap
         AND p.scope_type      = 'organization'
         AND p.scope_id IS NULL
         AND p.deny            = false
         AND p.revoked_at IS NULL
    ) THEN
      v_present := v_present + 1;
      RAISE NOTICE '[act-as] already present  % in % — left exactly as it is.', v_cap, r.slug;
    ELSE
      INSERT INTO permissions
        (organization_id, user_id, capability, scope_type, scope_id, deny, granted_by)
      VALUES
        (r.id, v_user_id, v_cap, 'organization', NULL, false, v_user_id);
      v_created := v_created + 1;
      RAISE NOTICE '[act-as] GRANTED        % to % in %', v_cap, v_email, r.slug;
    END IF;
  END LOOP;

  IF v_orgs = 0 THEN
    RAISE NOTICE '[act-as] SKIPPED — % holds no membership of any internal company, so there is no house to grant it in. Nothing written. 0013''s COMPANIES block says which company is internal here.', v_email;
  ELSE
    RAISE NOTICE '[act-as] % internal company(ies): % granted, % already present.', v_orgs, v_created, v_present;
    RAISE NOTICE '[act-as] To withdraw it later: UPDATE permissions SET revoked_at = now() WHERE capability = ''%'' AND revoked_at IS NULL; — or revoke() in lib/db/access.ts, which does the same thing.', v_cap;
  END IF;
END
$$;
