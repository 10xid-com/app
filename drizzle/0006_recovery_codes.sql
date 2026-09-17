CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint

-- The way back in when the authenticator is gone.
--
-- Once an account holds a confirmed authenticator the emailed code stops
-- working for it, so a lost phone would otherwise be a permanent lockout.
--
-- Same grants as the other identity tables: this is an input to the scope
-- rather than scoped data, and it is never enumerated — a row is found by the
-- hash of a code only the holder has. It carries no organization_id, so the
-- tenant check in scripts/check-rls.ts has nothing to say about it.
--
-- INSERT and UPDATE but no DELETE: a spent code is marked used, not removed,
-- so "this code was already redeemed" stays distinguishable from "this code
-- never existed" in the audit trail, while both look identical to a caller.
GRANT SELECT, INSERT, UPDATE ON recovery_codes TO portal_app;
