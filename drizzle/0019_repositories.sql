-- 0019 — REPOSITORIES: which client a GitHub repository belongs to, and which
-- repository and branch a conversation is about.
--
-- The GitHub App (read-only: Contents and Metadata) can see whatever it has
-- been installed on. That is not the same as a client being allowed to see
-- it. This table is the link that decides, and nothing reads a repository
-- that has no live link to the client in scope:
--
--   - a repository is linked to ONE client at a time (unique on the GitHub
--     repository id among live links), so one client's code can never be
--     listed in another client's workspace;
--   - a conversation names its repository by (id, client), referencing this
--     table by both, so a conversation cannot point at another client's
--     repository even by a forged id;
--   - the model is never given a repository identifier to choose. Its tools
--     are bound on the server to the conversation's repository and branch.
--
-- Unlinking is a timestamp, not a delete: past runs that read the repository
-- still say which one it was.

CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"installation_id" bigint NOT NULL,
	"external_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone,
	CONSTRAINT "repositories_provider_known" CHECK ("provider" IN ('github'))
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_id_org_key" UNIQUE ("id", "organization_id");--> statement-breakpoint
-- ONE live link per GitHub repository, across every client. The index is not
-- filtered by row-level security, which is the point: a second client cannot
-- link a repository the first already holds, even though it cannot see the
-- first client's row.
CREATE UNIQUE INDEX "repositories_live_external_idx" ON "repositories" USING btree ("provider", "external_id") WHERE "unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "repositories_org_idx" ON "repositories" USING btree ("organization_id");--> statement-breakpoint

-- The conversation's repository and branch, persisted with it so a refresh
-- comes back to the same place. Both null until one is chosen.
ALTER TABLE "conversations" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_repository_same_org_fk"
  FOREIGN KEY ("repository_id", "organization_id") REFERENCES "repositories" ("id", "organization_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_branch_needs_repository"
  CHECK ("branch" IS NULL OR "repository_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_branch_sane"
  CHECK ("branch" IS NULL OR (length("branch") BETWEEN 1 AND 255 AND "branch" !~ '\.\.' AND "branch" !~ '[[:cntrl:] ~^:?*\[\\]'));--> statement-breakpoint

-- Which run read which repository, at which commit. Null for runs without one.
ALTER TABLE "agent_runs" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_repository_same_org_fk"
  FOREIGN KEY ("repository_id", "organization_id") REFERENCES "repositories" ("id", "organization_id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON repositories TO portal_app;--> statement-breakpoint

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY repositories_tenant_isolation ON repositories
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
