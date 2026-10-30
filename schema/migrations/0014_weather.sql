ALTER TABLE "business_profile" ADD COLUMN "rain_threshold_pct" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "heat_threshold_f" integer DEFAULT 95 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "weather_lead_hours" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD COLUMN "weather_sensitive" boolean DEFAULT false NOT NULL;