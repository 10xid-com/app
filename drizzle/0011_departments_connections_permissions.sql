CREATE TYPE "public"."connection_source" AS ENUM('org_open', 'invitation', 'id_scan', 'shared_work', 'manual');--> statement-breakpoint
CREATE TYPE "public"."member_visibility" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."permission_scope" AS ENUM('organization', 'department', 'task_type', 'task', 'user');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"a_user_id" uuid NOT NULL,
	"b_user_id" uuid NOT NULL,
	"source" "connection_source" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "department_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"scope_type" "permission_scope" NOT NULL,
	"scope_id" uuid,
	"deny" boolean DEFAULT false NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "member_visibility" "member_visibility" DEFAULT 'closed' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_a_user_id_users_id_fk" FOREIGN KEY ("a_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_b_user_id_users_id_fk" FOREIGN KEY ("b_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_a_idx" ON "connections" USING btree ("a_user_id");--> statement-breakpoint
CREATE INDEX "connections_b_idx" ON "connections" USING btree ("b_user_id");--> statement-breakpoint
CREATE INDEX "connections_org_idx" ON "connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "department_members_dept_user_idx" ON "department_members" USING btree ("department_id","user_id");--> statement-breakpoint
CREATE INDEX "department_members_user_idx" ON "department_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_org_slug_idx" ON "departments" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "departments_org_idx" ON "departments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "permissions_user_idx" ON "permissions" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "permissions_org_capability_idx" ON "permissions" USING btree ("organization_id","capability");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A connection is a PAIR, stored once.
--
-- Seeing is mutual. If the pair could be stored in either order, the table
-- would eventually hold both (Tom, John) and (John, Tom) with different
-- revoked_at values, and there would be no answer to whether they can see
-- each other. Forcing the lower uuid into a_user_id makes the duplicate
-- impossible to write rather than merely discouraged.
-- ---------------------------------------------------------------------------
ALTER TABLE connections
  ADD CONSTRAINT connections_pair_ordered CHECK (a_user_id < b_user_id);

--> statement-breakpoint

-- One live connection per pair per context.
--
-- COALESCE, because organization_id is nullable for a personal iD-scan
-- connection, and NULL never equals NULL in a unique index — without it, the
-- same two people could accumulate unlimited duplicate personal connections.
-- The all-zero uuid is a stand-in for "no organization", not a real row.
CREATE UNIQUE INDEX connections_live_pair_idx
  ON connections (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    a_user_id,
    b_user_id
  )
  WHERE revoked_at IS NULL;

--> statement-breakpoint

-- A capability granted twice to the same person at the same scope is a
-- duplicate, not a stronger grant. A deny is a separate row and may coexist.
CREATE UNIQUE INDEX permissions_live_grant_idx
  ON permissions (
    organization_id,
    user_id,
    capability,
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    deny
  )
  WHERE revoked_at IS NULL;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  departments, department_members, permissions, connections
TO portal_app;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tenant isolation, same shape as jobs.
--
-- departments, department_members and permissions are ordinary client data:
-- they are read once a request is already scoped to one organization, so the
-- same filter applies and they fail closed on an unscoped connection.
--
-- `connections` is deliberately NOT here — see scripts/check-rls.ts. It holds
-- rows with a NULL organization_id (two people who scanned each other's iD,
-- which belongs to no company) and those rows can never match an org filter.
-- Protecting it would silently delete personal connections from every query.
-- ---------------------------------------------------------------------------
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY departments_tenant_isolation ON departments
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE department_members ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY department_members_tenant_isolation ON department_members
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY permissions_tenant_isolation ON permissions
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
