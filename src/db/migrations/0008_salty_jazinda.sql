CREATE TABLE "passenger_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"postal_code" text,
	"country_iso_code" text,
	"contact_email" text NOT NULL,
	"phone" text,
	"encrypted_iban" text,
	"encrypted_bic" text,
	"created_at_utc" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_utc" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passenger_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "passenger_profiles" ADD CONSTRAINT "passenger_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;