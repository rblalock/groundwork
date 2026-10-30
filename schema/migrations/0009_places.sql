CREATE TYPE "public"."geocode_status" AS ENUM('pending', 'ok', 'not_found', 'failed');--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "yard_lat" double precision;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "yard_lng" double precision;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "yard_geocoded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "yard_geocode_status" "geocode_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "yard_place_label" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "road_factor_bp" integer DEFAULT 13000 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "town_mph" integer DEFAULT 28 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "min_drive_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "lng" double precision;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "geocoded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "geocode_status" "geocode_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "place_label" text;