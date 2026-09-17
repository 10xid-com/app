CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON invitations TO portal_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- How somebody comes to have an account at all.
--
-- There is no open registration. A portal is several companies' data, and an
-- address typed into a form carries nothing that says which company it belongs
-- to — so an account starts from an invitation written by somebody who already
-- has access, naming both.
--
-- Same isolation as jobs: an invitation belongs to one company, and a session
-- scoped to another cannot see it, list it, write one into it, or withdraw one
-- out of it.
-- ---------------------------------------------------------------------------

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY invitations_tenant_isolation ON invitations
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY invitations_staff_read ON invitations
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint

-- The same narrow exception the api_keys table needs, for the same reason.
--
-- Somebody signing up has no session and no company yet — the invitation is
-- what PRODUCES both, so looking it up cannot require them. This policy admits
-- that one lookup:
--
--   * SELECT only, so nothing inside the flag can write an invitation or move
--     one between companies. Accepting one is a separate, scoped write.
--   * Gated on the transaction-local setting applied in exactly one function,
--     inAuthenticationTransaction(), whose only query here is a lookup by
--     exact address.
--
-- Unlike api_keys these rows hold an address rather than a hash, so the
-- exception is worth stating plainly: inside that one flag, a bug could read
-- pending invitations. It cannot read anything belonging to a client — no job,
-- no message, no file — and it cannot write at all.
CREATE POLICY invitations_accept_lookup ON invitations
  FOR SELECT
  TO portal_app
  USING (current_setting('app.authenticating', true) = 'on');
