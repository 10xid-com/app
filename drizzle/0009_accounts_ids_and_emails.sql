CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"id_code" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_id_code_unique" UNIQUE("id_code")
);
--> statement-breakpoint
CREATE TABLE "user_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_emails_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identities_user_idx" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_emails_user_idx" ON "user_emails" USING btree ("user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The two rules the model rests on, enforced here rather than in application
-- code, because neither survives being a convention.
-- ---------------------------------------------------------------------------

-- Exactly one primary address per account.
--
-- A plain UNIQUE (user_id, is_primary) would also permit only one NON-primary
-- address, which is the opposite of the point. The predicate is what makes this
-- "one true primary, any number of others".
CREATE UNIQUE INDEX user_emails_one_primary_per_user
  ON user_emails (user_id)
  WHERE is_primary;

--> statement-breakpoint

-- At most one LIVE iD per account.
--
-- Scoped to un-revoked rows so that giving up an iD and being issued another
-- later is possible, while holding two at once is not. Revoked rows stay for
-- the history and do not block the reissue.
CREATE UNIQUE INDEX identities_one_live_per_user
  ON identities (user_id)
  WHERE revoked_at IS NULL;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Every account that exists today has exactly one address, in users.email, and
-- it is by definition their primary. Its verified state is carried across
-- rather than reset: making everyone re-verify would be a self-inflicted
-- outage, and the fact was already established.
--
-- ON CONFLICT DO NOTHING makes this safe to run against a database where some
-- rows already landed — which is the state a half-applied migration leaves.
-- ---------------------------------------------------------------------------
INSERT INTO user_emails (user_id, email, is_primary, verified_at, created_at)
SELECT u.id, lower(u.email), true, u.email_verified_at, u.created_at
  FROM users u
 WHERE u.deleted_at IS NULL
ON CONFLICT (email) DO NOTHING;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Neither table carries an organization_id, so neither is tenant-scoped and
-- neither needs a row-level security policy — they are, like memberships, an
-- INPUT to a scope rather than scoped data. scripts/check-rls.ts looks for
-- tables carrying an organization id, so it will not flag these; that is
-- correct rather than an oversight, and this comment is where the reasoning
-- lives.
--
-- DELETE is deliberately withheld on identities. An iD that was issued and
-- given up is a fact worth keeping, and revoked_at already expresses it; a
-- DELETE would erase the only evidence that a code was ever in use, which is
-- precisely what must not be possible given codes are never reissued.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON user_emails TO portal_app;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON identities TO portal_app;
