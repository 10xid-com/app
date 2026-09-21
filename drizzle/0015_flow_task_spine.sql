-- FLOW, FIRST SLICE: THE SPINE. Touches, offers, claims, grades, events.
--
-- Read docs/flow/README.md before this file. It is the WHY and this is only
-- the HOW; where the two disagree the README wins and this file is wrong.
--
-- WHAT IS DELIBERATELY ABSENT: money. No rate, no pay, no price book, no
-- payout, no currency, no FX, no supplier and no purchase order. Rates are a
-- multiple of a local market reference with a recorded reason, per task type
-- AND per market, and that needs its own design around separate grants. Half
-- of it now would be a column somebody types a number into, which is exactly
-- the thing the README says drifts silently for two years. It is the next
-- slice.
--
-- FOUR RULES ARE ENFORCED HERE RATHER THAN IN TYPESCRIPT, because each of them
-- is one script away from being bypassed if it lives in the application:
--
--   1. The allowed time is PINNED at creation (flow_pin_allowed_time, and
--      flow_freeze_allowed_time which refuses to let it be edited afterwards).
--   2. An attempt's deadline is stamped from that pinned figure
--      (flow_stamp_claim_window).
--   3. A child row cannot belong to a different client from its task
--      (flow_inherit_task_org).
--   4. SEPARATION OF DUTY across the whole rework chain
--      (flow_enforce_separation_of_duty). This is the load-bearing one.
--
-- THIS FILE IS RE-RUNNABLE. Every statement is guarded, so applying it twice
-- succeeds and changes nothing the second time. That is not politeness: the
-- __drizzle_migrations bookkeeping has been lost on this database once
-- already, and a migration that cannot survive being replayed turns that from
-- an annoyance into an outage.

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Enums.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
    CREATE TYPE "public"."task_status" AS ENUM
      ('draft','open','claimed','submitted','approved','rejected','cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_offeree') THEN
    CREATE TYPE "public"."task_offeree" AS ENUM ('user','department','qualification');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'claim_outcome') THEN
    CREATE TYPE "public"."claim_outcome" AS ENUM ('submitted','released','expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grade_verdict') THEN
    CREATE TYPE "public"."grade_verdict" AS ENUM ('satisfactory','unsatisfactory');
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- TWO CLOCKS. This column is the client's.
--
-- The worker's window lives on `tasks` as std_minutes + buffer_minutes and is
-- measured in minutes. This one is a date the client is told, and it is
-- deliberately generous — an hour's work promised for tomorrow. The slack
-- between them is commercial safety and belongs to the business.
--
-- `jobs.due_at` already existed and is left exactly as it is. It predates this
-- distinction and nothing here knows what it means; guessing that it was the
-- promise and reusing it would have made whichever answer is wrong permanent.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS promised_at timestamp with time zone;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- QUALIFICATIONS ARE PERMISSIONS, WITH A LEVEL.
--
-- Somebody is in training at digitising, qualified at quoting and a trainer at
-- vectorising, all at once. That is a level per task type, not a flag, and it
-- goes on the existing permissions table rather than into a `qualifications`
-- table beside it — two tables answering "may Tom digitise" is two answers,
-- and the deny rule would only apply to one of them.
--
-- NULL on every grant that existed before this column, which means what it
-- always meant: the capability is held and it has no degrees.
-- ---------------------------------------------------------------------------
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS level integer;

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'permissions_level_range'
  ) THEN
    ALTER TABLE permissions
      ADD CONSTRAINT permissions_level_range
      CHECK (level IS NULL OR level BETWEEN 1 AND 3);
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE BUFFER BANDS, AS DATA.
--
-- A worker's window is the standard time plus a buffer, so somebody can answer
-- the door or take a call from their family without losing the job. 5/10/15 is
-- a first guess that will be revised once real people have been watched
-- working — and the README is explicit that it is a guess. A guess compiled
-- into a CASE statement needs a migration and a deploy to revise, so it lives
-- in rows.
--
-- No organization_id: this is the house's policy about its own workers, the
-- same in every client's jobs. It is therefore not tenant data and carries no
-- row-level security — see scripts/check-rls.ts, which only asks the question
-- of tables that carry an organization id.
--
-- Bounds are half-open: min inclusive, max exclusive, NULL max meaning "and
-- everything above". Live bands may not overlap, enforced by an exclusion
-- constraint rather than by care, because two bands covering 25 minutes is not
-- a preference — it is one question with two answers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "task_time_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_std_minutes" integer NOT NULL,
	"max_std_minutes" integer,
	"buffer_minutes" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_time_bands_sane') THEN
    ALTER TABLE task_time_bands ADD CONSTRAINT task_time_bands_sane CHECK (
      min_std_minutes >= 0
      AND buffer_minutes >= 0
      AND (max_std_minutes IS NULL OR max_std_minutes > min_std_minutes)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_time_bands_no_overlap') THEN
    ALTER TABLE task_time_bands ADD CONSTRAINT task_time_bands_no_overlap
      EXCLUDE USING gist (int4range(min_std_minutes, max_std_minutes) WITH &&)
      WHERE (deleted_at IS NULL);
  END IF;
END
$$;

--> statement-breakpoint

-- The bands from docs/flow/README.md. Inserted only if the table is empty, so
-- a replay of this migration never resurrects a band somebody has since
-- retired or edited — which would be this file silently overruling a policy
-- decision made after it.
INSERT INTO task_time_bands (min_std_minutes, max_std_minutes, buffer_minutes, note)
SELECT * FROM (VALUES
  (0,  20,   5, 'Under 20 minutes. A three-minute quote is allowed eight.'),
  (20, 41,  10, '20 to 40 minutes inclusive.'),
  (41, NULL, 15, 'Over 40 minutes. A one-hour digitise is allowed an hour and fifteen.')
) AS v(min_std_minutes, max_std_minutes, buffer_minutes, note)
WHERE NOT EXISTS (SELECT 1 FROM task_time_bands);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "task_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"std_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);

--> statement-breakpoint

-- `id` has no default on purpose: it is a UUIDv7 supplied by the caller, the
-- same rule `jobs` follows. Postgres 16 has no native uuidv7(), and a
-- gen_random_uuid() default would quietly hand out v4s that fragment the index
-- and read as if they were ordered.
--
-- allowed_minutes is GENERATED — the worker's whole window, kept in step by
-- the database instead of by whoever writes the next insert.
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"task_type_id" uuid NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"title" text,
	"parent_task_id" uuid,
	"approves_task_id" uuid,
	"std_minutes" integer NOT NULL,
	"buffer_minutes" integer NOT NULL,
	"allowed_minutes" integer NOT NULL GENERATED ALWAYS AS (std_minutes + buffer_minutes) STORED,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"offeree_type" "task_offeree" NOT NULL,
	"user_id" uuid,
	"department_id" uuid,
	"qualification_task_type_id" uuid,
	"min_qualification_level" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"outcome" "claim_outcome",
	"outcome_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"claim_id" uuid,
	"grader_user_id" uuid NOT NULL,
	"verdict" "grade_verdict" NOT NULL,
	"score" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_email_at_time" text,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Foreign keys. Named exactly as drizzle-kit would have named them, so a
-- future generated migration diffs to nothing rather than to a rename.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('task_types',  'task_types_organization_id_organizations_id_fk',  'organization_id',            'organizations', 'id'),
      ('tasks',       'tasks_organization_id_organizations_id_fk',       'organization_id',            'organizations', 'id'),
      ('tasks',       'tasks_job_id_jobs_id_fk',                         'job_id',                     'jobs',          'id'),
      ('tasks',       'tasks_task_type_id_task_types_id_fk',             'task_type_id',               'task_types',    'id'),
      ('tasks',       'tasks_parent_task_id_tasks_id_fk',                'parent_task_id',             'tasks',         'id'),
      ('tasks',       'tasks_approves_task_id_tasks_id_fk',              'approves_task_id',           'tasks',         'id'),
      ('tasks',       'tasks_created_by_users_id_fk',                    'created_by',                 'users',         'id'),
      ('task_offers', 'task_offers_organization_id_organizations_id_fk', 'organization_id',            'organizations', 'id'),
      ('task_offers', 'task_offers_task_id_tasks_id_fk',                 'task_id',                    'tasks',         'id'),
      ('task_offers', 'task_offers_user_id_users_id_fk',                 'user_id',                    'users',         'id'),
      ('task_offers', 'task_offers_department_id_departments_id_fk',     'department_id',              'departments',   'id'),
      ('task_offers', 'task_offers_qualification_task_type_id_task_types_id_fk', 'qualification_task_type_id', 'task_types', 'id'),
      ('task_offers', 'task_offers_created_by_users_id_fk',              'created_by',                 'users',         'id'),
      ('task_claims', 'task_claims_organization_id_organizations_id_fk', 'organization_id',            'organizations', 'id'),
      ('task_claims', 'task_claims_task_id_tasks_id_fk',                 'task_id',                    'tasks',         'id'),
      ('task_claims', 'task_claims_user_id_users_id_fk',                 'user_id',                    'users',         'id'),
      ('task_grades', 'task_grades_organization_id_organizations_id_fk', 'organization_id',            'organizations', 'id'),
      ('task_grades', 'task_grades_task_id_tasks_id_fk',                 'task_id',                    'tasks',         'id'),
      ('task_grades', 'task_grades_claim_id_task_claims_id_fk',          'claim_id',                   'task_claims',   'id'),
      ('task_grades', 'task_grades_grader_user_id_users_id_fk',          'grader_user_id',             'users',         'id'),
      ('task_events', 'task_events_task_id_tasks_id_fk',                 'task_id',                    'tasks',         'id'),
      ('task_events', 'task_events_organization_id_organizations_id_fk', 'organization_id',            'organizations', 'id'),
      ('task_events', 'task_events_actor_id_users_id_fk',                'actor_id',                   'users',         'id')
    ) AS v(tbl, name, col, reftbl, refcol)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(%I) ON DELETE no action ON UPDATE no action',
        fk.tbl, fk.name, fk.col, fk.reftbl, fk.refcol);
    END IF;
  END LOOP;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Indexes.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "task_types_org_slug_idx" ON "task_types" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_types_org_idx" ON "task_types" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_org_status_idx" ON "tasks" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_job_idx" ON "tasks" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_approves_idx" ON "tasks" USING btree ("approves_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_offers_task_idx" ON "task_offers" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_offers_user_idx" ON "task_offers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_offers_department_idx" ON "task_offers" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_offers_qualification_idx" ON "task_offers" USING btree ("qualification_task_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_claims_task_idx" ON "task_claims" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_claims_user_idx" ON "task_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_grades_task_idx" ON "task_grades" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_grades_grader_idx" ON "task_grades" USING btree ("grader_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_events_task_idx" ON "task_events" USING btree ("task_id");

--> statement-breakpoint

-- ONE LIVE ATTEMPT PER TASK.
--
-- `outcome IS NULL` is what "still running" means, and two such rows on one
-- task would be two people both believing the job is theirs. This is the
-- second half of the claim race guard: the conditional UPDATE on tasks.status
-- decides the winner, and this makes the losing insert impossible even if some
-- future caller forgets the UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS task_claims_one_live_idx
  ON task_claims (task_id) WHERE outcome IS NULL;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Check constraints.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_types_std_minutes_positive') THEN
    ALTER TABLE task_types ADD CONSTRAINT task_types_std_minutes_positive
      -- The smallest unit is one minute. A zero-minute standard time would
      -- make the buffer the whole window and the standard time decorative.
      CHECK (std_minutes > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_minutes_sane') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_minutes_sane
      CHECK (std_minutes > 0 AND buffer_minutes >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_not_own_parent') THEN
    -- A one-row cycle would make the rework chain walk forever, and the
    -- separation-of-duty trigger walks it on every claim.
    ALTER TABLE tasks ADD CONSTRAINT tasks_not_own_parent
      CHECK (parent_task_id IS NULL OR parent_task_id <> id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_not_own_approval') THEN
    -- Nothing approves itself. That is the whole point of the next section.
    ALTER TABLE tasks ADD CONSTRAINT tasks_not_own_approval
      CHECK (approves_task_id IS NULL OR approves_task_id <> id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_offers_exactly_one_target') THEN
    -- Three shapes in one table, never two at once. An offer that named both a
    -- person and a department would have two different answers to "who may
    -- claim this", and the claim path would pick whichever it read first.
    ALTER TABLE task_offers ADD CONSTRAINT task_offers_exactly_one_target CHECK (
      (offeree_type = 'user'
        AND user_id IS NOT NULL AND department_id IS NULL
        AND qualification_task_type_id IS NULL AND min_qualification_level IS NULL)
      OR
      (offeree_type = 'department'
        AND department_id IS NOT NULL AND user_id IS NULL
        AND qualification_task_type_id IS NULL AND min_qualification_level IS NULL)
      OR
      (offeree_type = 'qualification'
        AND qualification_task_type_id IS NOT NULL
        AND min_qualification_level BETWEEN 1 AND 3
        AND user_id IS NULL AND department_id IS NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_claims_outcome_dated') THEN
    -- An outcome without a time cannot be ordered against anything else, and a
    -- time without an outcome says something ended without saying how — which
    -- is the exact distinction between a release and an expiry.
    ALTER TABLE task_claims ADD CONSTRAINT task_claims_outcome_dated
      CHECK ((outcome IS NULL) = (outcome_at IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_claims_window_forward') THEN
    ALTER TABLE task_claims ADD CONSTRAINT task_claims_window_forward
      CHECK (expires_at > claimed_at);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_grades_score_range') THEN
    -- Optional, and bounded when present. Binary is right for technical work;
    -- the score is here so creative work does not need a second grading system.
    ALTER TABLE task_grades ADD CONSTRAINT task_grades_score_range
      CHECK (score IS NULL OR score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_events_actor_named') THEN
    -- Either a person acted and is named, or the system did and nobody is.
    -- Half of each would be an audit row that cannot say who.
    ALTER TABLE task_events ADD CONSTRAINT task_events_actor_named
      CHECK ((actor_id IS NULL) = (actor_email_at_time IS NULL));
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE BAND LOOKUP. One place that answers "how long is this person allowed".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION flow_buffer_minutes(p_std_minutes integer)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_buffer integer;
BEGIN
  SELECT buffer_minutes INTO v_buffer
    FROM task_time_bands
   WHERE deleted_at IS NULL
     AND p_std_minutes >= min_std_minutes
     AND (max_std_minutes IS NULL OR p_std_minutes < max_std_minutes)
   ORDER BY min_std_minutes DESC
   LIMIT 1;

  IF v_buffer IS NULL THEN
    RAISE EXCEPTION
      'no live band in task_time_bands covers a standard time of % minutes',
      p_std_minutes
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_buffer;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- PINNING. The allowed time is decided once, at creation, and never again.
--
-- Change the bands next month and nothing in flight moves. Retune a task
-- type's standard time — which the README expects, since an extension granted
-- because "our estimate was wrong" IS the signal to retune it — and nothing in
-- flight moves either.
--
-- It is a trigger rather than application code for the reason every rule in
-- this file is: the first script anybody writes to backfill or repair tasks
-- will insert rows directly, and it will be right about the columns it knows
-- and silent about the ones it does not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION flow_pin_allowed_time()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_std integer;
BEGIN
  IF NEW.std_minutes IS NULL THEN
    SELECT std_minutes INTO v_std FROM task_types WHERE id = NEW.task_type_id;
    IF v_std IS NULL THEN
      RAISE EXCEPTION 'task type % has no standard time, or does not exist', NEW.task_type_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.std_minutes := v_std;
  END IF;

  IF NEW.buffer_minutes IS NULL THEN
    NEW.buffer_minutes := flow_buffer_minutes(NEW.std_minutes);
  END IF;

  RETURN NEW;
END
$$;

--> statement-breakpoint

-- The other half of pinning, and the half that is easy to forget: a pin that
-- can be edited is not a pin. Nothing may move a task's window after the fact,
-- because the person holding it agreed to that window.
CREATE OR REPLACE FUNCTION flow_freeze_allowed_time()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.std_minutes IS DISTINCT FROM OLD.std_minutes
     OR NEW.buffer_minutes IS DISTINCT FROM OLD.buffer_minutes THEN
    RAISE EXCEPTION
      'the allowed time on task % is pinned at creation (% + % minutes) and cannot be changed; raise a new task instead',
      OLD.id, OLD.std_minutes, OLD.buffer_minutes
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An attempt's deadline, stamped from the task's PINNED figure.
--
-- On the claim and not on the task, because a second attempt gets its own full
-- window rather than the remains of somebody else's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION flow_stamp_claim_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allowed integer;
BEGIN
  IF NEW.expires_at IS NULL THEN
    SELECT allowed_minutes INTO v_allowed FROM tasks WHERE id = NEW.task_id;
    IF v_allowed IS NULL THEN
      RAISE EXCEPTION 'task % does not exist', NEW.task_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.expires_at := NEW.claimed_at + (v_allowed * interval '1 minute');
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A child row belongs to its task's client. Filled when absent, refused when
-- contradictory — a claim row pointing at one client's task while carrying
-- another client's id would be visible to the wrong company under the tenant
-- policy, which is the one thing this database is built not to allow.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION flow_inherit_task_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM tasks WHERE id = NEW.task_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'task % does not exist', NEW.task_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION
      '% row names client % but its task belongs to client %',
      TG_TABLE_NAME, NEW.organization_id, v_org
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- SEPARATION OF DUTY. The load-bearing rule, and the reason it is here.
--
--   "The person who DOES the work must be a different person at a DIFFERENT
--    COMPANY from the person who approves it."
--
-- It closes an exploit for free. An approver is paid to reject; if they could
-- then claim the rework they would be paid twice for one judgement, and the
-- judgement is theirs to make. So the constraint must survive the rework
-- chain, where the second attempt is a NEW row with no memory of who rejected
-- the first.
--
-- A CHECK cannot express any of this: it is a rule about other rows. An
-- application check cannot either — not because it would be wrong today, but
-- because the first repair script, the first backfill and the first admin
-- screen written in a hurry all go straight to the table.
--
-- The three helper functions below are SECURITY DEFINER. They have to be: the
-- application connects as a restricted role under row-level security, and a
-- rule that can only see the rows the caller can see is a rule that passes
-- whenever the caller is scoped narrowly enough. They only ever SELECT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION flow_task_chain(p_task_id uuid)
RETURNS TABLE (task_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE chain(id, parent_task_id) AS (
    SELECT t.id, t.parent_task_id FROM tasks t WHERE t.id = p_task_id
    UNION
    SELECT t.id, t.parent_task_id FROM tasks t JOIN chain c ON t.id = c.parent_task_id
  )
  SELECT id FROM chain;
$$;

--> statement-breakpoint

-- Same company = any shared membership. Two people who both belong to Rotary
-- are at the same company even if one is an owner and the other a member.
CREATE OR REPLACE FUNCTION flow_same_company(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM memberships ma
      JOIN memberships mb ON mb.organization_id = ma.organization_id
     WHERE ma.user_id = p_a
       AND mb.user_id = p_b
  );
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION flow_enforce_separation_of_duty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid;
  v_task    uuid;
  v_reviews uuid;
  v_clash   uuid;
BEGIN
  IF TG_TABLE_NAME = 'task_grades' THEN
    -- Writing a grade IS approving. The task being reviewed is this one.
    v_actor   := NEW.grader_user_id;
    v_task    := NEW.task_id;
    v_reviews := NEW.task_id;
  ELSE
    -- Claiming a task. If that task exists to inspect another one, this claim
    -- puts the claimant on the reviewing side of the rule.
    v_actor := NEW.user_id;
    v_task  := NEW.task_id;
    SELECT t.approves_task_id INTO v_reviews FROM tasks t WHERE t.id = v_task;
  END IF;

  -- -------------------------------------------------------------------
  -- Reviewing side: you may not inspect work you or your company did.
  -- The whole chain, not one row — a rework's earlier attempts count.
  -- -------------------------------------------------------------------
  IF v_reviews IS NOT NULL THEN
    SELECT c.user_id INTO v_clash
      FROM task_claims c
     WHERE c.task_id IN (SELECT task_id FROM flow_task_chain(v_reviews))
       AND (c.user_id = v_actor OR flow_same_company(c.user_id, v_actor))
     ORDER BY (c.user_id = v_actor) DESC
     LIMIT 1;

    IF v_clash IS NOT NULL THEN
      IF v_clash = v_actor THEN
        RAISE EXCEPTION
          'separation of duty: % may not approve task % because they did the work on it or on an earlier attempt at it',
          v_actor, v_reviews
          USING ERRCODE = 'check_violation';
      ELSE
        RAISE EXCEPTION
          'separation of duty: % may not approve task % because % did the work on it and they are at the same company',
          v_actor, v_reviews, v_clash
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- -------------------------------------------------------------------
  -- Doing side: you may not do work you or your company is set to judge.
  --
  -- This is the rework case the README calls out. The approver who rejected
  -- attempt one has no presence on attempt two's row at all — the link is
  -- parent_task_id, and it has to be walked to find them.
  -- -------------------------------------------------------------------
  IF TG_TABLE_NAME = 'task_claims' AND v_reviews IS NULL THEN
    SELECT judge.user_id INTO v_clash
      FROM (
        -- Anybody who has graded anything in this task's chain.
        SELECT g.grader_user_id AS user_id
          FROM task_grades g
         WHERE g.task_id IN (SELECT task_id FROM flow_task_chain(v_task))
        UNION
        -- Anybody holding a claim on an approval touch pointing at this chain,
        -- which is what "was SET TO approve" means: they took the review on,
        -- whether or not they have filed a verdict yet.
        SELECT c.user_id
          FROM task_claims c
          JOIN tasks a ON a.id = c.task_id
         WHERE a.approves_task_id IN (SELECT task_id FROM flow_task_chain(v_task))
      ) AS judge
     WHERE judge.user_id = v_actor OR flow_same_company(judge.user_id, v_actor)
     ORDER BY (judge.user_id = v_actor) DESC
     LIMIT 1;

    IF v_clash IS NOT NULL THEN
      IF v_clash = v_actor THEN
        RAISE EXCEPTION
          'separation of duty: % may not claim task % because they approved, or were set to approve, an earlier attempt at it',
          v_actor, v_task
          USING ERRCODE = 'check_violation';
      ELSE
        RAISE EXCEPTION
          'separation of duty: % may not claim task % because % approved, or was set to approve, an earlier attempt at it and they are at the same company',
          v_actor, v_task, v_clash
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Wiring. DROP then CREATE, because Postgres 16 has no CREATE OR REPLACE
-- TRIGGER for this shape and this file must survive being replayed.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS tasks_pin_allowed_time ON tasks;--> statement-breakpoint
CREATE TRIGGER tasks_pin_allowed_time
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION flow_pin_allowed_time();

--> statement-breakpoint

DROP TRIGGER IF EXISTS tasks_freeze_allowed_time ON tasks;--> statement-breakpoint
CREATE TRIGGER tasks_freeze_allowed_time
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION flow_freeze_allowed_time();

--> statement-breakpoint

DROP TRIGGER IF EXISTS task_claims_stamp_window ON task_claims;--> statement-breakpoint
CREATE TRIGGER task_claims_stamp_window
  BEFORE INSERT ON task_claims
  FOR EACH ROW EXECUTE FUNCTION flow_stamp_claim_window();

--> statement-breakpoint

DROP TRIGGER IF EXISTS task_offers_inherit_org ON task_offers;--> statement-breakpoint
CREATE TRIGGER task_offers_inherit_org
  BEFORE INSERT ON task_offers
  FOR EACH ROW EXECUTE FUNCTION flow_inherit_task_org();

--> statement-breakpoint

DROP TRIGGER IF EXISTS task_claims_inherit_org ON task_claims;--> statement-breakpoint
CREATE TRIGGER task_claims_inherit_org
  BEFORE INSERT ON task_claims
  FOR EACH ROW EXECUTE FUNCTION flow_inherit_task_org();

--> statement-breakpoint

DROP TRIGGER IF EXISTS task_grades_inherit_org ON task_grades;--> statement-breakpoint
CREATE TRIGGER task_grades_inherit_org
  BEFORE INSERT ON task_grades
  FOR EACH ROW EXECUTE FUNCTION flow_inherit_task_org();

--> statement-breakpoint

DROP TRIGGER IF EXISTS task_events_inherit_org ON task_events;--> statement-breakpoint
CREATE TRIGGER task_events_inherit_org
  BEFORE INSERT ON task_events
  FOR EACH ROW EXECUTE FUNCTION flow_inherit_task_org();

--> statement-breakpoint

-- Separation of duty fires on BOTH paths into approval, because there are two:
-- taking on the approval touch, and filing the verdict.
DROP TRIGGER IF EXISTS task_claims_separation_of_duty ON task_claims;--> statement-breakpoint
CREATE TRIGGER task_claims_separation_of_duty
  BEFORE INSERT ON task_claims
  FOR EACH ROW EXECUTE FUNCTION flow_enforce_separation_of_duty();

--> statement-breakpoint

DROP TRIGGER IF EXISTS task_grades_separation_of_duty ON task_grades;--> statement-breakpoint
CREATE TRIGGER task_grades_separation_of_duty
  BEFORE INSERT ON task_grades
  FOR EACH ROW EXECUTE FUNCTION flow_enforce_separation_of_duty();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants.
--
-- No DELETE anywhere. A claim, a grade and an event are evidence: a released
-- claim that can be deleted is a released claim that can be made to look like
-- it never happened, and the whole release-versus-expiry distinction rests on
-- the record surviving. Tasks and offers are withdrawn by stamping
-- deleted_at / revoked_at, the same as everything else in this schema.
--
-- Grades and events get INSERT and SELECT only, like job_events: a verdict is
-- amended by filing another one, not by editing the first.
-- ---------------------------------------------------------------------------
GRANT SELECT ON task_time_bands TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON task_types, tasks, task_offers, task_claims TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT ON task_grades, task_events TO portal_app;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE task_events_id_seq TO portal_app;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tenant isolation. Same shape as jobs and as 0011: the filter reads a
-- transaction-local setting, and an unscoped connection matches no rows, so
-- forgetting to scope returns nothing rather than returning everything.
--
-- All six carry organization_id directly — denormalised on purpose, so one
-- identical filter applies to every table with no joins.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_types','tasks','task_offers','task_claims','task_grades','task_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        FOR ALL TO portal_app
        USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END
$$;
