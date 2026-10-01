-- 0018 — THE WORKSPACE: conversations with a model, kept, scoped and receipted.
--
-- /chat stops being a stateless box and becomes a workspace that belongs to one
-- client. A conversation belongs to a workspace; every model run inside it
-- records what the model was shown and which tools it ran, so "what did the
-- model actually see?" has an answer that is a row rather than a guess.
--
-- Repositories and attachments arrive in later migrations and add columns and
-- tables beside these. Nothing here can write to a repository: the mode column
-- refuses `build` outright until approval, audit and rollback exist.
--
-- ISOLATION IS TWO KEYS, NOT ONE. Every table that holds conversation content
-- is filtered by BOTH the client (app.org_id, as everywhere) AND the person who
-- owns the conversation (app.user_id, set by inTenantTransaction from this
-- migration on). Two staff members working on the same client do not read each
-- other's conversations: what somebody asked a model while thinking out loud is
-- theirs, and a shared client is not a reason to publish it. There is no
-- staff-survey policy on any of these tables — unlike jobs, no session ever
-- sees conversations across clients.
--
-- Ids are generated in application code (UUIDv7, lib/ids.ts) because they
-- appear in URLs; there is no column default to fall back on by accident.

CREATE TYPE "public"."conversation_mode" AS ENUM('ask', 'plan', 'build');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."receipt_kind" AS ENUM('file', 'folder', 'job', 'attachment', 'tool_call', 'warning');--> statement-breakpoint
CREATE TYPE "public"."context_kind" AS ENUM('file', 'folder', 'job');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A workspace is one client's place to work with a model. Shared by the staff
-- who work on that client; the conversations inside it are not.
-- ---------------------------------------------------------------------------
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One live workspace per client until repositories exist; 0019 widens this to
-- one per client and repository.
CREATE UNIQUE INDEX "workspaces_org_live_idx" ON "workspaces" USING btree ("organization_id") WHERE "archived_at" IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A conversation. The mode is a column the database checks, not a flag the
-- interface remembers: `build` is defined so the shape is agreed, and refused
-- by a constraint until it is designed.
-- ---------------------------------------------------------------------------
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"title" text NOT NULL,
	"mode" "conversation_mode" DEFAULT 'ask' NOT NULL,
	"engine_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "conversations_no_build_yet" CHECK ("mode" <> 'build'),
	CONSTRAINT "conversations_title_sane" CHECK (length(btrim("title")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_owner_recent_idx" ON "conversations" USING btree ("organization_id", "created_by", "updated_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The messages. Append-only: SELECT and INSERT only for the application, so
-- what was said cannot be edited afterwards to match what was answered.
-- `command` is the explicit /review /explain /plan /test choice, stored as
-- data, so a command is a recorded decision and never an invisible prompt.
-- ---------------------------------------------------------------------------
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"command" text,
	"run_id" uuid,
	"status" text DEFAULT 'complete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_status_known" CHECK ("status" IN ('complete', 'cut_off', 'failed')),
	CONSTRAINT "conversation_messages_command_known" CHECK ("command" IS NULL OR "command" IN ('review', 'explain', 'plan', 'test'))
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_idx" ON "conversation_messages" USING btree ("conversation_id", "created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- One model run: which provider, which model, which mode, how it ended. The
-- receipts below hang off it. UPDATE is granted only so a run can be closed.
-- ---------------------------------------------------------------------------
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"mode" "conversation_mode" NOT NULL,
	"engine_mode" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_no_build_yet" CHECK ("mode" <> 'build')
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_message_id_conversation_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "agent_runs" USING btree ("conversation_id", "started_at");--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What a run saw and did. One row per file inspected, business record
-- consulted, attachment sent, tool executed or warning raised.
-- `sent_to_provider` is the line that matters most: it separates what the
-- application looked at from what actually left for the provider named on the
-- run. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE "agent_run_receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" "receipt_kind" NOT NULL,
	"label" text NOT NULL,
	"ref" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_to_provider" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_receipts" ADD CONSTRAINT "agent_run_receipts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_receipts" ADD CONSTRAINT "agent_run_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_receipts" ADD CONSTRAINT "agent_run_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_receipts_run_idx" ON "agent_run_receipts" USING btree ("run_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What the person put into a conversation's context on purpose: a job now, a
-- file or folder once repositories exist. Removing is a timestamp, so the
-- context a past run used can still be read back.
-- ---------------------------------------------------------------------------
CREATE TABLE "conversation_context_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" "context_kind" NOT NULL,
	"ref" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversation_context_items" ADD CONSTRAINT "conversation_context_items_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_items" ADD CONSTRAINT "conversation_context_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_context_items" ADD CONSTRAINT "conversation_context_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_context_items_live_idx" ON "conversation_context_items" USING btree ("conversation_id", "kind", "ref") WHERE "removed_at" IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Which engine modes a client's work may be sent to. No row means allowed;
-- `allowed = false` withholds a mode from that client, so a client who has
-- not agreed to a provider can be kept off it without a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE "engine_mode_policies" (
	"organization_id" uuid NOT NULL,
	"engine_mode" text NOT NULL,
	"allowed" boolean NOT NULL,
	"set_by" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engine_mode_policies_pk" PRIMARY KEY ("organization_id", "engine_mode")
);
--> statement-breakpoint
ALTER TABLE "engine_mode_policies" ADD CONSTRAINT "engine_mode_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_mode_policies" ADD CONSTRAINT "engine_mode_policies_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- PARENT AND CHILD MUST AGREE ON WHOSE THEY ARE.
--
-- A plain foreign key checks that the parent exists — and foreign key checks
-- are not filtered by row-level security. Without these, a message could be
-- written into someone else's conversation by naming its id, with the
-- message's own organization and owner columns satisfying every policy. Each
-- child therefore references its parent by (id, organization, owner), so a
-- row whose parent belongs to another client or another person cannot exist.
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces ADD CONSTRAINT workspaces_id_org_key UNIQUE (id, organization_id);--> statement-breakpoint
ALTER TABLE conversations ADD CONSTRAINT conversations_id_org_owner_key UNIQUE (id, organization_id, created_by);--> statement-breakpoint
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_id_org_owner_key UNIQUE (id, organization_id, created_by);--> statement-breakpoint
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_id_org_owner_key UNIQUE (id, organization_id, created_by);--> statement-breakpoint

ALTER TABLE conversations ADD CONSTRAINT conversations_workspace_same_org_fk
  FOREIGN KEY (workspace_id, organization_id) REFERENCES workspaces (id, organization_id);--> statement-breakpoint
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_same_owner_fk
  FOREIGN KEY (conversation_id, organization_id, created_by) REFERENCES conversations (id, organization_id, created_by);--> statement-breakpoint
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_conversation_same_owner_fk
  FOREIGN KEY (conversation_id, organization_id, created_by) REFERENCES conversations (id, organization_id, created_by);--> statement-breakpoint
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_message_same_owner_fk
  FOREIGN KEY (user_message_id, organization_id, created_by) REFERENCES conversation_messages (id, organization_id, created_by);--> statement-breakpoint
ALTER TABLE agent_run_receipts ADD CONSTRAINT agent_run_receipts_same_owner_fk
  FOREIGN KEY (run_id, organization_id, created_by) REFERENCES agent_runs (id, organization_id, created_by);--> statement-breakpoint
ALTER TABLE conversation_context_items ADD CONSTRAINT conversation_context_items_same_owner_fk
  FOREIGN KEY (conversation_id, organization_id, created_by) REFERENCES conversations (id, organization_id, created_by);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants. Messages and receipts are append-only by permission, not by habit.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON workspaces TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON conversations TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT ON conversation_messages TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON agent_runs TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT ON agent_run_receipts TO portal_app;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE agent_run_receipts_id_seq TO portal_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON conversation_context_items TO portal_app;--> statement-breakpoint
GRANT SELECT ON engine_mode_policies TO portal_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- workspaces and engine_mode_policies: the client only — they are shared by
-- everyone working on that client.
--
-- Everything holding conversation content: the client AND the owner. An empty
-- app.user_id (a transaction opened without one) matches nobody, so a code
-- path that forgets to say who is asking reads nothing rather than everything.
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY workspaces_tenant_isolation ON workspaces
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE engine_mode_policies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY engine_mode_policies_tenant_isolation ON engine_mode_policies
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY conversations_owner_isolation ON conversations
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY conversation_messages_owner_isolation ON conversation_messages
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_runs_owner_isolation ON agent_runs
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE agent_run_receipts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_run_receipts_owner_isolation ON agent_run_receipts
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE conversation_context_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY conversation_context_items_owner_isolation ON conversation_context_items
  FOR ALL TO portal_app
  USING      (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid);
