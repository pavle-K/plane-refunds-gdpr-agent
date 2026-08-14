ALTER TABLE "claims" ADD COLUMN "booking_reference" text;--> statement-breakpoint
-- Backfill pre-existing rows (all dev/test artifacts predating this column)
-- with their own id — globally unique, so it trivially satisfies the
-- per-user uniqueness constraint added below without inventing a fake
-- booking reference that could collide with a real one.
UPDATE "claims" SET "booking_reference" = "id" WHERE "booking_reference" IS NULL;--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "booking_reference" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_booking_reference_unique" UNIQUE("user_id","booking_reference");
