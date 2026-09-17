CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"prefix" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_service_user_id_users_id_fk" FOREIGN KEY ("service_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON api_keys TO portal_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Keys for machines.
--
-- A client's own website has work to hand over and nobody signed in behind it.
-- The credential for that is its own thing: bound to one company, stored as a
-- hash, revocable without touching a person's login.
--
-- Isolation is the same tenant rule as jobs. A key row belongs to one company,
-- and a session scoped to another company cannot see it, list it, mint one into
-- it, or revoke one out of it.
-- ---------------------------------------------------------------------------

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY api_keys_tenant_isolation ON api_keys
  FOR ALL
  TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY api_keys_staff_read ON api_keys
  FOR SELECT
  TO portal_app
  USING (current_setting('app.is_staff', true) = 'on');--> statement-breakpoint

-- The one exception, and the reason this table is not simply exempt from
-- row-level security the way sessions are.
--
-- A key must be found before anyone knows which company it belongs to, so the
-- lookup cannot be scoped — it is what produces the scope. This policy admits
-- that single lookup and nothing else:
--
--   * SELECT only, so a caller inside this flag cannot mint a key or move one
--     between companies.
--   * Gated on a transaction-local setting applied in exactly one function,
--     inAuthenticationTransaction(), whose only query is a lookup by hash.
--   * The rows it admits hold hashes, not keys, so seeing them all is not the
--     same as holding any of them.
--
-- Management of the same table stays under the tenant rule above.
CREATE POLICY api_keys_authenticate ON api_keys
  FOR SELECT
  TO portal_app
  USING (current_setting('app.authenticating', true) = 'on');
