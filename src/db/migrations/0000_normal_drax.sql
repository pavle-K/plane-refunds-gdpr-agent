CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at_utc" timestamp with time zone DEFAULT now() NOT NULL
);
