CREATE TABLE "airports" (
	"iata_code" text PRIMARY KEY NOT NULL,
	"icao_code" text NOT NULL,
	"name" text NOT NULL,
	"country_iso_code" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"source" text NOT NULL,
	"created_at_utc" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_utc" timestamp with time zone DEFAULT now() NOT NULL
);
