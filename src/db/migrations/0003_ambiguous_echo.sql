CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at_utc" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- channel_identities: add the owning user, nullable first so this works against
-- a table that may already have rows (no prior notion of "user" existed before
-- this migration). Backfill one new user per pre-existing identity — matches the
-- v1 "one channel identity = one user" model — then enforce NOT NULL.
ALTER TABLE "channel_identities" ADD COLUMN "user_id" uuid;--> statement-breakpoint
DO $$
DECLARE
	identity RECORD;
	new_user_id uuid;
BEGIN
	FOR identity IN SELECT id FROM "channel_identities" WHERE "user_id" IS NULL LOOP
		INSERT INTO "users" DEFAULT VALUES RETURNING id INTO new_user_id;
		UPDATE "channel_identities" SET "user_id" = new_user_id WHERE id = identity.id;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "channel_identities" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- email_connections: same nullable-then-backfill-then-NOT NULL approach. There's
-- no prior link from a connection to any channel identity to inherit ownership
-- from, so each pre-existing orphan connection also gets its own fresh user —
-- flagged here as a one-time migration caveat, not a real ownership decision;
-- any pre-existing connection should be re-verified via the hosted OAuth flow
-- once real users exist.
ALTER TABLE "email_connections" DROP CONSTRAINT "email_connections_provider_email_address_unique";--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "user_id" uuid;--> statement-breakpoint
DO $$
DECLARE
	connection RECORD;
	new_user_id uuid;
BEGIN
	FOR connection IN SELECT id FROM "email_connections" WHERE "user_id" IS NULL LOOP
		INSERT INTO "users" DEFAULT VALUES RETURNING id INTO new_user_id;
		UPDATE "email_connections" SET "user_id" = new_user_id WHERE id = connection.id;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "email_connections" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_email_address_unique" UNIQUE("email_address");--> statement-breakpoint

-- audit_log: nullable, no backfill needed (see schema.ts — not every entry is
-- user-attributable).
ALTER TABLE "audit_log" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"channel" text NOT NULL,
	"consented_at_utc" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "oauth_pending_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_identity_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text,
	"created_at_utc" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at_utc" timestamp with time zone NOT NULL,
	"consumed_at_utc" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oauth_pending_flows" ADD CONSTRAINT "oauth_pending_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_pending_flows" ADD CONSTRAINT "oauth_pending_flows_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "claims" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at_utc" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_utc" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
